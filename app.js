/*
  app.js

  Browser-only person detection + simple centroid tracker.
  - Uses COCO-SSD via TensorFlow.js to detect objects in each frame.
  - Filters detections for class === 'person'.
  - Assigns stable temporary IDs (ID1, ID2, ...) using centroid matching.
  - Draws bounding boxes and IDs on a canvas overlay.

  Notes:
  - All computations run locally in the browser (no backend).
  - Designed to work on desktop and mobile; use `playsInline` and responsive layout.
*/

// DOM elements
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusLabel = document.getElementById('status');
const facingSelect = document.getElementById('facingSelect');

let model = null; // loaded COCO-SSD model
let stream = null; // MediaStream from getUserMedia
let running = false; // loop state
let facingMode = 'user'; // 'user' (front) or 'environment' (rear)
let frameSkip = 2; // process detection every N frames (reduce CPU)
let frameCounter = 0;

// Proximity / Grouping state
const proximity = {
  threshold: 100, // pixels (default proximity distance)
  minGroupSize: 2,
  groups: {}, // current groups by id
  lastMembership: {}, // trackId -> groupId
  nextGroupId: 1
};

// stabilization / debounce
proximity.joinFrames = 3;
proximity.leaveFrames = 3;
proximity.counters = {}; // trackId -> consecutive frame count for pending change
proximity.stableMembership = {}; // confirmed membership after debounce

// Event log
const eventLog = { entries: [], max: 80 };
const eventListEl = document.getElementById('eventList');
const clearLogBtn = document.getElementById('clearLog');
if(clearLogBtn){ clearLogBtn.addEventListener('click', ()=>{ eventLog.entries = []; renderEventLog(); }); }

function pushEvent(text){
  const ts = new Date();
  const entry = { t: ts, text };
  eventLog.entries.unshift(entry);
  if(eventLog.entries.length > eventLog.max) eventLog.entries.length = eventLog.max;
  renderEventLog();
  // optional narration for lay users
  if(narrationEnabled){ speakEvent(text); }
}

function renderEventLog(){
  if(!eventListEl) return;
  eventListEl.innerHTML = '';
  for(const e of eventLog.entries){
    const li = document.createElement('li');
    const time = document.createElement('span'); time.className='time'; time.textContent = e.t.toLocaleTimeString();
    li.appendChild(time);
    li.appendChild(document.createTextNode(e.text));
    eventListEl.appendChild(li);
  }
}

// Wire up proximity controls in UI
const proximityThreshEl = document.getElementById('proximityThresh');
const proximityValEl = document.getElementById('proximityVal');
const proximityDebounceEl = document.getElementById('proximityDebounce');
const proximityDebounceVal = document.getElementById('proximityDebounceVal');
if(proximityThreshEl){
  proximityThreshEl.addEventListener('input', ()=>{
    proximity.threshold = Number(proximityThreshEl.value);
    if(proximityValEl) proximityValEl.textContent = proximityThreshEl.value;
  });
}
if(proximityDebounceEl){
  proximityDebounceEl.addEventListener('input', ()=>{
    const v = Number(proximityDebounceEl.value);
    proximity.joinFrames = v; proximity.leaveFrames = v;
    if(proximityDebounceVal) proximityDebounceVal.textContent = String(v);
  });
}

// Debug visuals toggle (UI checkbox wired below)
const debugToggleEl = document.getElementById('debugToggle');
let debugVisuals = false;
if(debugToggleEl){
  debugToggleEl.addEventListener('change', ()=>{ debugVisuals = !!debugToggleEl.checked; });
}

// Novice mode, narration and heatmap toggles
const noviceToggleEl = document.getElementById('noviceToggle');
const narrationToggleEl = document.getElementById('narrationToggle');
const heatmapToggleEl = document.getElementById('heatmapToggle');
let noviceMode = false;
let narrationEnabled = false;
let heatmapEnabled = false;
if(noviceToggleEl) noviceToggleEl.addEventListener('change', ()=>{ noviceMode = !!noviceToggleEl.checked; });
if(narrationToggleEl) narrationToggleEl.addEventListener('change', ()=>{ narrationEnabled = !!narrationToggleEl.checked; });
if(heatmapToggleEl) heatmapToggleEl.addEventListener('change', ()=>{ heatmapEnabled = !!heatmapToggleEl.checked; });

// Heatmap state (initialized in resizeOverlay)
let heatmapGrid = null; let heatmapW = 0; let heatmapH = 0; let heatmapCell = 16; let heatmapDecay = 0.96;

function speakEvent(text){
  if(!narrationEnabled) return;
  try{
    const u = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.cancel(); // avoid overlapping
    window.speechSynthesis.speak(u);
  }catch(e){/* ignore speech errors */}
}

// Tracker state
let nextId = 1; // counter for generating IDs
// We'll use a Tracker class (SORT-like): each Track contains a Kalman filter,
// a unique ID, and bookkeeping. The Tracker performs prediction, matching
// (IoU-based) and updates tracks, handling short occlusions and stable IDs.

// --- Linear algebra helpers for small matrices ---
function matMul(A, B){
  const m = A.length, n = B[0].length, p = B.length;
  const C = Array.from({length:m}, ()=>Array(n).fill(0));
  for(let i=0;i<m;i++) for(let k=0;k<p;k++){
    const aik = A[i][k];
    for(let j=0;j<n;j++) C[i][j] += aik * B[k][j];
  }
  return C;
}
function matAdd(A,B){ return A.map((r,i)=>r.map((v,j)=>v + B[i][j])); }
function matSub(A,B){ return A.map((r,i)=>r.map((v,j)=>v - B[i][j])); }
function matTranspose(A){ return A[0].map((_,i)=>A.map(r=>r[i])); }
function matIdentity(n){ return Array.from({length:n}, (_,i)=>Array.from({length:n}, (__,j)=> i===j?1:0)); }

// Inverse for 4x4 or small matrices using Gaussian elimination
function matInverse(A){
  const n = A.length;
  const M = A.map(r=>r.slice());
  const I = matIdentity(n);
  for(let i=0;i<n;i++){
    // find pivot
    let pivot = i;
    for(let r=i;r<n;r++) if(Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    if(Math.abs(M[pivot][i]) < 1e-12) return null;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    [I[i], I[pivot]] = [I[pivot], I[i]];
    const diag = M[i][i];
    for(let j=0;j<n;j++){ M[i][j] /= diag; I[i][j] /= diag; }
    for(let r=0;r<n;r++) if(r!==i){
      const factor = M[r][i];
      for(let c=0;c<n;c++){ M[r][c] -= factor * M[i][c]; I[r][c] -= factor * I[i][c]; }
    }
  }
  return I;
}

// Convert bbox format
function tlwhToTlbr(b){ const [x,y,w,h]=b; return [x, y, x+w, y+h]; }
function tlbrToTlwh(b){ const [x1,y1,x2,y2]=b; return [x1, y1, x2-x1, y2-y1]; }
function tlwhToCxCyWh(b){ const [x,y,w,h]=b; return [x + w/2, y + h/2, w, h]; }
function cxCyWhToTlwh(c){ const [cx,cy,w,h]=c; return [cx - w/2, cy - h/2, w, h]; }

function iou(bbox1, bbox2){
  // bbox: [x,y,w,h]
  const a = tlwhToTlbr(bbox1);
  const b = tlwhToTlbr(bbox2);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const w = Math.max(0, x2-x1);
  const h = Math.max(0, y2-y1);
  const inter = w*h;
  const areaA = (a[2]-a[0])*(a[3]-a[1]);
  const areaB = (b[2]-b[0])*(b[3]-b[1]);
  const uni = areaA + areaB - inter;
  return uni <= 0 ? 0 : inter/uni;
}

// HSV to RGB helper (h in [0,1], s,v in [0,1])
function hsvToRgb(h, s, v){
  let r=0,g=0,b=0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch(i % 6){
    case 0: r=v; g=t; b=p; break;
    case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break;
    case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break;
    case 5: r=v; g=p; b=q; break;
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

// Small helper to draw rounded rectangles (fill and/or stroke)
function roundRect(ctx, x, y, w, h, r, fill, stroke){
  if(typeof r === 'undefined') r = 5;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if(fill) ctx.fill();
  if(stroke) ctx.stroke();
}

// Map normalized speed (0..1) to color from green (slow) -> yellow -> red (fast)
function speedToColor(norm){
  // clamp
  const t = Math.max(0, Math.min(1, norm));
  // green to red via hue 0.33 -> 0
  const hue = 0.33 * (1 - t); // 0.33 (green) down to 0 (red)
  const rgb = hsvToRgb(hue, 1, 0.9);
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// Map hue (0..1) to a simple color name
function hueToName(h){
  const t = (h % 1 + 1) % 1;
  const sector = Math.floor(t * 8);
  switch(sector){
    case 0: return 'Red';
    case 1: return 'Orange';
    case 2: return 'Yellow';
    case 3: return 'Green';
    case 4: return 'Cyan';
    case 5: return 'Blue';
    case 6: return 'Purple';
    case 7: return 'Magenta';
    default: return 'Color';
  }
}

// --- Appearance (color histogram) helpers ---
// Offscreen canvas for cropping the video frames for appearance extraction
const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');
const APP_BINS = 16; // hue bins

// Convert RGB to HSV hue (0..1)
function rgbToHue(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const d = max - min;
  if(d === 0) return 0;
  let h;
  if(max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if(max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6; // normalize to [0,1)
  return h;
}

// Compute normalized hue histogram for a bbox on the video element
function getAppearanceHistogram(bbox){
  const [x,y,w,h] = bbox.map(v=>Math.max(0, Math.round(v)));
  // small crop size to reduce cost
  const CW = 64, CH = 64;
  cropCanvas.width = CW; cropCanvas.height = CH;
  try{
    // draw the bbox area from the video to the small canvas
    cropCtx.drawImage(video, x, y, w, h, 0, 0, CW, CH);
  }catch(e){
    // drawing can fail if video not ready
    return new Array(APP_BINS).fill(1/APP_BINS);
  }
  const img = cropCtx.getImageData(0,0,CW,CH).data;
  const hist = new Array(APP_BINS).fill(0);
  let count = 0;
  for(let i=0;i<img.length;i+=4){
    const r = img[i], g = img[i+1], b = img[i+2], a = img[i+3];
    if(a < 64) continue; // skip transparent-ish pixels
    const v = Math.max(r,g,b);
    if(v < 16) continue; // ignore near-black pixels
    const hval = rgbToHue(r,g,b);
    const bin = Math.floor(hval * APP_BINS) % APP_BINS;
    hist[bin] += 1;
    count++;
  }
  if(count === 0) return new Array(APP_BINS).fill(1/APP_BINS);
  for(let i=0;i<APP_BINS;i++) hist[i] /= count; // normalize
  return hist;
}

// Bhattacharyya coefficient between two normalized histograms (0..1)
function bhattacharyya(a,b){
  if(!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for(let i=0;i<a.length;i++) s += Math.sqrt(a[i]*b[i]);
  return Math.max(0, Math.min(1, s));
}

// --- Track and Tracker classes ---
class Track{
  constructor(bbox, id){
    // Initialize Kalman state vector [cx,cy,w,h,vx,vy,vw,vh]
    const [cx,cy,w,h] = tlwhToCxCyWh(bbox);
    this.x = [[cx],[cy],[w],[h],[0],[0],[0],[0]]; // 8x1
    this.P = matIdentity(8).map((r,i)=>r.map((v,j)=> v * (i<4?10:1000)) );
    // State transition
    this.F = matIdentity(8);
    this.F[0][4] = 1; this.F[1][5] = 1; this.F[2][6] = 1; this.F[3][7] = 1;
    // Measurement matrix maps state to measurement [cx,cy,w,h]
    this.H = Array.from({length:4}, (_,i)=>Array.from({length:8}, (_,j)=> j===i?1:0));
    // Process and measurement noise
    this.Q = matIdentity(8).map((r,i)=>r.map((v,j)=> v * (i<4?1:10)));
    this.R = matIdentity(4).map(r=>r.map((v,i)=> v * 10));

    this.id = id;
    this.hits = 1; // total hits
    this.time_since_update = 0; // frames since last update
    this.age = 0; // total frames
    this.lastBBox = bbox.slice();
    this.history = [];
    this.startTime = Date.now();
    // motionHistory keeps recent centroids for motion visualization and matching
    this.motionHistory = [];
  }

  predict(){
    // x = F x
    this.x = matMul(this.F, this.x);
    // P = F P F^T + Q
    this.P = matAdd(matMul(matMul(this.F, this.P), matTranspose(this.F)), this.Q);
    this.age += 1;
    this.time_since_update += 1;
    // return predicted bbox in tlwh
    const cx = this.x[0][0], cy = this.x[1][0], w = this.x[2][0], h = this.x[3][0];
    const tlwh = cxCyWhToTlwh([cx,cy,w,h]);
    this.lastBBox = tlwh.map(v => Number.isFinite(v)?v:0);
    // update motion history with predicted centroid
    const c = bboxToCentroid(this.lastBBox);
    this.motionHistory.push(c);
    if(this.motionHistory.length > 12) this.motionHistory.shift();
    return this.lastBBox;
  }

  update(bbox){
    // measurement z = [cx,cy,w,h]
    const [cx,cy,w,h] = tlwhToCxCyWh(bbox);
    const z = [[cx],[cy],[w],[h]];
    // y = z - H x
    const y = matSub(z, matMul(this.H, this.x));
    // S = H P H^T + R
    const S = matAdd(matMul(matMul(this.H, this.P), matTranspose(this.H)), this.R);
    const SInv = matInverse(S);
    if(!SInv) return; // numerical issue
    // K = P H^T S^-1
    const K = matMul(matMul(this.P, matTranspose(this.H)), SInv);
    // x = x + K y
    this.x = matAdd(this.x, matMul(K, y));
    // P = (I - K H) P
    const I = matIdentity(this.P.length);
    const KH = matMul(K, this.H);
    const IKH = matSub(I, KH);
    this.P = matMul(IKH, this.P);

    this.time_since_update = 0;
    this.hits += 1;
    this.lastBBox = bbox.slice();
    this.history.push(bbox.slice());
    // update motion history with measurement centroid
    const c = bboxToCentroid(this.lastBBox);
    this.motionHistory.push(c);
    if(this.motionHistory.length > 12) this.motionHistory.shift();
  }
}

class Tracker{
  constructor(){
    this.tracks = [];
    this.nextId = 1;
    // Increased defaults for stability
    this.max_age = 150; // frames (~several seconds depending on fps)
    this.min_hits = 3; // hits to consider confirmed (reduce spurious IDs)
    this.iou_threshold = 0.2; // matching threshold (IoU part)
    // weights for combined cost: IoU, motion, appearance
    this.match_weight_iou = 0.5;
    this.match_weight_motion = 0.3;
    this.match_weight_app = 0.2;
    this.motion_gate = 0.6; // normalized distance gate (relative to frame diag)
  }

  predict(){
    const preds = this.tracks.map(t=>t.predict());
    return preds;
  }

  update(detections){
    // detections: array of bbox [x,y,w,h]
    // 1) Predict all tracks
    const predicts = this.tracks.map(t=>{ return t.lastBBox.slice(); });

    // 2) Build IoU + motion + appearance matrices and run Hungarian assignment
    const M = this.tracks.length, N = detections.length;
    const iouMat = Array.from({length:M}, ()=>Array(N).fill(0));
    const distNormMat = Array.from({length:M}, ()=>Array(N).fill(0));
    const appMat = Array.from({length:M}, ()=>Array(N).fill(0));
    for(let i=0;i<M;i++) for(let j=0;j<N;j++) iouMat[i][j] = iou(this.tracks[i].lastBBox, detections[j].bbox);

    const matchedPairs = [];
    const unmatchedTracks = [];
    const unmatchedDetections = [];

    if(M > 0 && N > 0){
      // cost matrix: lower is better. Combine IoU and motion distance.
      const size = Math.max(M,N);
      const cost = Array.from({length:size}, (_,i)=>Array(size).fill(1e6));
      // compute frame diagonal for normalization
      const frameDiag = Math.hypot(overlay.width || 640, overlay.height || 480);
      for(let i=0;i<M;i++){
        // predicted centroid for track i
        const ctr = tlwhToCxCyWh(this.tracks[i].lastBBox);
        for(let j=0;j<N;j++){
          const detCtr = tlwhToCxCyWh(detections[j].bbox);
          const dx = ctr[0]-detCtr[0];
          const dy = ctr[1]-detCtr[1];
          const dist = Math.hypot(dx,dy);
          const distNorm = dist / frameDiag; // normalized
          distNormMat[i][j] = distNorm;
          const iouVal = iouMat[i][j];
          // appearance similarity
          let appSim = 0.0;
          if(this.tracks[i].appearance && detections[j].appearance){
            appSim = bhattacharyya(this.tracks[i].appearance, detections[j].appearance);
          }
          appMat[i][j] = appSim;
          // gating: if too far, disallow match by large cost
          if(distNorm > this.motion_gate){
            cost[i][j] = 1e6;
          }else{
            const c = this.match_weight_iou * (1 - iouVal)
                    + this.match_weight_motion * distNorm
                    + this.match_weight_app * (1 - appSim);
            cost[i][j] = Math.max(0, c);
          }
        }
      }
      // Fill remaining rows/cols with large cost to make square
      // Hungarian assignment
      const assignment = hungarian(cost);
      const usedT = new Set();
      const usedD = new Set();
      for(const [r,c] of assignment){
        if(r < M && c < N){
          const assignedCost = cost[r][c];
          if(assignedCost < 1e5){
            matchedPairs.push([r,c]);
            usedT.add(r); usedD.add(c);
          }
        }
      }
      for(let i=0;i<M;i++) if(!usedT.has(i)) unmatchedTracks.push(i);
      for(let j=0;j<N;j++) if(!usedD.has(j)) unmatchedDetections.push(j);
      // Update matched tracks and record per-match info
      this.lastMatches = { matches: [], unmatchedTracks: unmatchedTracks.slice(), unmatchedDetections: unmatchedDetections.slice() };
      for(const [ti, dj] of matchedPairs) {
        // store info for debug/visualization
        const info = {
          trackIndex: ti,
          detIndex: dj,
          trackId: this.tracks[ti].id,
          det: detections[dj],
          iou: iouMat[ti][dj],
          distNorm: distNormMat[ti][dj],
          appSim: appMat[ti][dj],
          cost: cost[ti][dj]
        };
        this.lastMatches.matches.push(info);
        // apply measurement update
        this.tracks[ti].update(detections[dj].bbox);
        // update appearance (EMA)
        const detApp = detections[dj].appearance || null;
        if(detApp){
          if(!this.tracks[ti].appearance) this.tracks[ti].appearance = detApp.slice();
          else{
            const alpha = 0.6; // EMA weight for new appearance
            for(let k=0;k<detApp.length;k++) this.tracks[ti].appearance[k] = alpha*detApp[k] + (1-alpha)*this.tracks[ti].appearance[k];
          }
        }
      }
      // store unmatched arrays on lastMatches as well
      this.lastMatches.unmatchedTracks = unmatchedTracks.slice();
      this.lastMatches.unmatchedDetections = unmatchedDetections.slice();
    }else{
      // trivial cases
      for(let i=0;i<M;i++) unmatchedTracks.push(i);
      for(let j=0;j<N;j++) unmatchedDetections.push(j);
      this.lastMatches = { matches: [], unmatchedTracks: unmatchedTracks.slice(), unmatchedDetections: unmatchedDetections.slice() };
    }

    // keep a snapshot of detections for visualization/debugging
    this.lastDetections = detections.map(d => ({ bbox: d.bbox.slice(), score: d.score, appearance: d.appearance }));

    // 5) Create new tracks for unmatched detections
    for(const dj of unmatchedDetections){
      const det = detections[dj];
      const trk = new Track(det.bbox, `ID${this.nextId++}`);
      trk.appearance = det.appearance ? det.appearance.slice() : null;
      this.tracks.push(trk);
    }

    // 6) Age and remove dead tracks
    const survivors = [];
    for(const t of this.tracks){
      if(t.time_since_update > 0){
        // not updated this frame
      }
      // remove if too old
      if(t.time_since_update <= this.max_age){ survivors.push(t); }
    }
    this.tracks = survivors;
  }

  getActiveTracks(){
    // Return tracks considered active (confirmed by min_hits and not expired)
    return this.tracks.filter(t=> t.hits >= this.min_hits && t.time_since_update <= this.max_age);
  }
}

// Instantiate tracker
const tracker = new Tracker();

// --- Hungarian (Munkres) algorithm implementation ---
// Returns array of [row, col] assignments for a square cost matrix (NxN).
function hungarian(costMatrix){
  // Implementation adapted for small matrices; costMatrix is square NxN
  const n = costMatrix.length;
  const cost = costMatrix.map(r=>r.slice());
  const u = Array(n+1).fill(0), v = Array(n+1).fill(0);
  const p = Array(n+1).fill(0), way = Array(n+1).fill(0);
  for(let i=1;i<=n;i++){
    p[0] = i;
    let j0 = 0;
    const minv = Array(n+1).fill(Infinity);
    const used = Array(n+1).fill(false);
    do{
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for(let j=1;j<=n;j++) if(!used[j]){
        const cur = cost[i0-1][j-1] - u[i0] - v[j];
        if(cur < minv[j]){ minv[j] = cur; way[j] = j0; }
        if(minv[j] < delta){ delta = minv[j]; j1 = j; }
      }
      for(let j=0;j<=n;j++){
        if(used[j]){ u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while(p[j0] !== 0);
    do{
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while(j0);
  }
  const assignment = [];
  for(let j=1;j<=n;j++) if(p[j]>0) assignment.push([p[j]-1, j-1]);
  return assignment;
}

// Parameters for tracker
const MAX_DISAPPEARED_MS = 1500; // time after which a track is removed if not seen
const MAX_MATCH_DISTANCE = 120; // pixels; max allowed distance for matching centroids

// Utility: compute centroid of bbox
function bboxToCentroid(bbox){
  const [x, y, w, h] = bbox;
  return [x + w/2, y + h/2];
}

// Utility: squared distance
function dist2(a, b){
  const dx = a[0]-b[0];
  const dy = a[1]-b[1];
  return dx*dx + dy*dy;
}

// (Replaced by Tracker class above)

// Draw all tracks on overlay canvas
function drawOverlay(){
  const ctx = overlay.getContext('2d');
  // Clear
  ctx.clearRect(0,0,overlay.width, overlay.height);

  ctx.strokeStyle = '#00FF7F';
  ctx.lineWidth = Math.max(2, Math.round(overlay.width/400));
  ctx.font = `${14 + Math.round(overlay.width/200)}px sans-serif`;
  ctx.textBaseline = 'top';

  const active = tracker.getActiveTracks();
  for(const t of active){
    const [x,y,w,h] = t.lastBBox;
    // Expand box slightly for better visibility (pad by 8% of max(dim) or at least 8px)
    const pad = Math.max(8, Math.round(0.08 * Math.max(w,h)));
    let px = x - pad;
    let py = y - pad;
    let pw = w + pad*2;
    let ph = h + pad*2;
    // Clamp to canvas
    px = Math.max(0, px); py = Math.max(0, py);
    if(px + pw > overlay.width) pw = overlay.width - px;
    if(py + ph > overlay.height) ph = overlay.height - py;
    // Draw padded box
    ctx.beginPath();
    ctx.rect(px,py,pw,ph);
    ctx.stroke();

    // Draw filled background for label for readability
    const label = t.id;
    const textWidth = ctx.measureText(label).width;
    const padding = 4;
    const boxW = textWidth + padding*2;
    const boxH = parseInt(ctx.font,10) + padding;
    // Place label above padded bounding box if possible
    let lx = px;
    let ly = Math.max(0, py - boxH - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(lx, ly, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + padding, ly + 1);
    // Plain-language group/alone badge (bilingual)
    try{
      const lang = document.body.classList.contains('lang-en') ? 'en' : 'de';
      const member = proximity.stableMembership && proximity.stableMembership[t.id] ? proximity.stableMembership[t.id] : (proximity.lastMembership && proximity.lastMembership[t.id]) || null;
      let badgeText = '';
      if(member){
        const grp = proximity.groups && proximity.groups[member];
        const cnt = grp ? grp.members.length : '';
        badgeText = lang === 'en' ? `In group ${member} (${cnt})` : `In Gruppe ${member} (${cnt})`;
      }else{
        badgeText = lang === 'en' ? 'Alone' : 'Allein';
      }
      // draw small rounded badge to the right of the label
      ctx.font = '11px sans-serif';
      const bpad = 6;
      const bW = Math.min(240, Math.round(ctx.measureText(badgeText).width + bpad*2));
      const bH = 18;
      const bx = lx + boxW + 8;
      const by = ly;
      // clamp inside canvas
      const bxClamped = bx + bW + 8 > overlay.width ? Math.max(8, overlay.width - bW - 12) : bx;
      ctx.fillStyle = member ? 'rgba(30,120,200,0.9)' : 'rgba(50,160,60,0.9)';
      roundRect(ctx, bxClamped, by, bW, bH, 6, true, false);
      ctx.fillStyle = '#fff'; ctx.fillText(badgeText, bxClamped + bpad, by + 3);
    }catch(e){/* ignore badge errors */}
    // Dwell badge removed here to avoid duplication; dwell is shown in the per-track mini-legend
    // and as the right-side progress bar next to histogram/motion.
    // --- Mini-legend placed inside the padded box (avoid histogram/motion overlap) ---
    try{
      ctx.save();
      ctx.font = '11px sans-serif';
      const legW = Math.min(72, Math.round(overlay.width * 0.12));
      const legH = 8;
      const gapY = 6;
      // preferred position: just under the ID, inside the padded bbox
      let appX = Math.max(px + 8, Math.min(lx, px + pw - legW - 8));
      let appY = py + 8; // inside top of box

      // compute total legend height (appearance + speed + spacing)
      const totalH = legH * 3 + gapY * 2; // Appearance + Speed + Dwell

      // helper for rectangle overlap
      function rectsOverlap(aX,aY,aW,aH,bX,bY,bW,bH){
        return !(aX + aW < bX || bX + bW < aX || aY + aH < bY || bY + bH < aY);
      }

      // if histogram/motion areas exist, check for overlap and try alternative positions
      const legendRect = () => [appX, appY, legW, totalH];
      let hx_, hy_, histW_, histH_, mx_, my_, motionH_;
      try{ hx_ = hx; hy_ = hy; histW_ = histW; histH_ = histH; mx_ = mx; my_ = my; motionH_ = motionH; }catch(e){ /* may be undefined */ }

      let overlaps = false;
      if(typeof hx_ !== 'undefined'){
        const [lxr, lyr, lwr, lhr] = legendRect();
        if(rectsOverlap(lxr, lyr, lwr, lhr, hx_, hy_, histW_, histH_)) overlaps = true;
        if(rectsOverlap(lxr, lyr, lwr, lhr, mx_, my_, histW_, motionH_)) overlaps = true;
      }

      if(overlaps){
        // try placing legend at left-inside box (appX already inside), but lower to avoid motion area
        appY = py + Math.max(8, Math.min(ph - totalH - 8, 12));
        // recompute overlaps
        if(typeof hx_ !== 'undefined'){
          const [lxr, lyr, lwr, lhr] = legendRect();
          if(rectsOverlap(lxr, lyr, lwr, lhr, hx_, hy_, histW_, histH_) || rectsOverlap(lxr, lyr, lwr, lhr, mx_, my_, histW_, motionH_)){
            // last resort: place legend inside top-left corner of box
            appX = px + 6;
            appY = py + 6;
            // if still overlaps (tiny boxes), hide legend by setting a flag
            const [lxr2, lyr2, lwr2, lhr2] = legendRect();
            if(typeof hx_ !== 'undefined' && (rectsOverlap(lxr2, lyr2, lwr2, lhr2, hx_, hy_, histW_, histH_) || rectsOverlap(lxr2, lyr2, lwr2, lhr2, mx_, my_, histW_, motionH_))){
              // don't draw
              ctx.restore();
              throw new Error('no-space-for-mini-legend');
            }
          }
        }
      }

      // Appearance (hue) gradient
      const appGrad = ctx.createLinearGradient(appX, appY, appX + legW, appY);
      const stops = 6;
      for(let i=0;i<=stops;i++){ const tstop = i/stops; const rgb = hsvToRgb(tstop,1,0.85); appGrad.addColorStop(tstop, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`); }
      ctx.fillStyle = appGrad;
      roundRect(ctx, appX, appY, legW, legH, 3, true, true);
      ctx.fillStyle = '#fff';
      ctx.fillText('Appearance', appX + legW + 8, appY - 1);
      // Speed legend under appearance
      const spY = appY + legH + 6;
      const spGrad = ctx.createLinearGradient(appX, spY, appX + legW, spY);
      spGrad.addColorStop(0, speedToColor(0)); spGrad.addColorStop(1, speedToColor(1));
      ctx.fillStyle = spGrad;
      roundRect(ctx, appX, spY, legW, legH, 3, true, true);
      ctx.fillStyle = '#fff';
      ctx.fillText('Speed', appX + legW + 8, spY - 1);
      // Dwell legend under speed (shows description + current seconds)
      const dwellY = spY + legH + 6;
      // small progress-like bar background with colored outline depending on dwell
      const dwellSecLabel = Math.floor((Date.now() - t.startTime)/1000);
      function dwellColorFor(s){
        if(s >= 60) return '#FF6666'; // red
        if(s >= 30) return '#FFD166'; // yellow
        return '#66FF66'; // green
      }
      const dwellClr = dwellColorFor(dwellSecLabel);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeStyle = dwellClr;
      ctx.lineWidth = 1.2;
      roundRect(ctx, appX, dwellY, legW, legH, 3, true, true);
      // label + current seconds
      ctx.fillStyle = '#fff';
      ctx.fillText('Dwell', appX + legW + 8, dwellY - 1);
      ctx.font = '11px sans-serif';
      ctx.fillStyle = dwellClr; // color the numeric dwell value
      ctx.fillText(`${dwellSecLabel}s`, appX + legW + 8 + 48, dwellY - 1);
      ctx.font = '11px sans-serif';
      ctx.restore();
    }catch(e){/* ignore per-track legend errors or intentional hide */}
    // compute histogram/motion placement with clamping so it's visible on small screens
    const bins = (t.appearance && t.appearance.length) || APP_BINS;
    const barW = Math.max(4, Math.min(10, Math.round(overlay.width/140)));
    const histW = bins * barW;
    const histH = 20;
    let hx = px + pw + 8; // desired right side
    let hy = py;
    // clamp hx/hy into canvas bounds
    if(hx + histW + 8 > overlay.width) hx = Math.max(8, overlay.width - histW - 8);
    if(hy + histH + 40 > overlay.height) hy = Math.max(8, overlay.height - histH - 40);

    // Draw appearance histogram if available
    if(t.appearance){
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(hx - 2, hy - 2, histW + 4, histH + 4);
      for(let i=0;i<bins;i++){
        const val = t.appearance[i] || 0;
        const hcol = i / bins; // hue
        const rgb = hsvToRgb(hcol, 1, 0.8);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        const bw = barW - 1;
        const bh = Math.max(1, Math.round(val * histH));
        const bx = hx + i*barW;
        const by = hy + (histH - bh);
        ctx.fillRect(bx, by, bw, bh);
      }
      // Dominant color swatch + percent (most intuitive summary for viewers)
      try{
        const maxIdx = t.appearance.reduce((mi,v,i)=> v>t.appearance[mi]?i:mi, 0);
        const maxVal = t.appearance[maxIdx] || 0;
        const hue = maxIdx / bins;
        const swSize = Math.max(12, Math.round(histH));
        let swX = hx + histW + 8;
        const swY = hy;
        if(swX + swSize + 40 > overlay.width) swX = hx - swSize - 8; // place left if not enough space
        const rgb = hsvToRgb(hue, 1, 0.85);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(swX, swY, swSize, swSize);
        // text label
        const name = hueToName(hue);
        const pct = Math.round(maxVal * 100);
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'top';
        const tx = swX + swSize + 6;
        const ty = swY;
        ctx.fillText(`${name} ${pct}%`, tx, ty);
      }catch(e){ /* ignore */ }
    }

    // Draw dwell time next to histogram/motion area on the right side (smart placement)
    try{
      const dwellSecR = Math.floor((Date.now() - t.startTime)/1000);
      const maxTR = 60;
      const progressR = Math.min(1, dwellSecR / maxTR);
      const bw = 12; const bh = Math.max(30, motionH || 20);

      // helper to test overlap
      function rectsOverlap(aX,aY,aW,aH,bX,bY,bW,bH){
        return !(aX + aW < bX || bX + bW < aX || aY + aH < bY || bY + bH < aY);
      }

      // compute candidate positions in order of preference
      const candidates = [];
      // 1) right of histogram (preferred)
      if(typeof hx !== 'undefined') candidates.push({x: hx + histW + 8, y: hy});
      // 2) right of swatch if present
      if(typeof swX !== 'undefined') candidates.push({x: swX + (Math.max(12, Math.round(histH)) ) + 8, y: hy});
      // 3) right of padded bbox
      candidates.push({x: px + pw + 8, y: py});
      // 4) below motion area
      if(typeof my !== 'undefined') candidates.push({x: hx, y: my + motionH + 6});
      // 5) top-right corner of canvas
      candidates.push({x: overlay.width - bw - 12, y: 12});

      let placed = false;
      for(const c of candidates){
        const rx = Math.round(c.x);
        const ry = Math.round(c.y);
        // ensure inside canvas horizontally
        if(rx < 6 || rx + bw + 6 > overlay.width) continue;
        if(ry < 6 || ry + bh + 6 > overlay.height) continue;
        // avoid overlapping histogram/motion/swatch areas
        let conflict = false;
        if(typeof hx !== 'undefined' && rectsOverlap(rx, ry, bw, bh, hx-4, hy-4, histW+8, histH+8)) conflict = true;
        if(typeof mx !== 'undefined' && rectsOverlap(rx, ry, bw, bh, mx-4, my-4, histW+8, motionH+8)) conflict = true;
        if(typeof swX !== 'undefined' && rectsOverlap(rx, ry, bw, bh, swX-4, swY-4, 24, 24)) conflict = true;
        if(conflict) continue;
        // place here
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        roundRect(ctx, rx, ry, bw, bh, 4, true, false);
        const dwellClrR = (function(s){ if(s>=60) return '#FF6666'; if(s>=30) return '#FFD166'; return '#66FF66'; })(dwellSecR);
        ctx.fillStyle = dwellClrR;
        const fillH = Math.max(2, Math.round(bh * progressR));
        ctx.fillRect(rx + 1, ry + bh - fillH - 1, bw - 2, fillH);
        ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif';
        const txt = `${dwellSecR}s`;
        const tx2 = rx + bw + 8;
        const ty2 = ry + Math.round(bh/2) - 8;
        ctx.fillText(txt, tx2, ty2);
        placed = true;
        break;
      }
      // if not placed, skip right-side dwell to avoid overlap
    }catch(e){/* ignore right-side dwell render errors */}

    // Draw motion pattern below histogram (regardless of appearance presence)
    const motionH = 20;
    const mx = hx;
    const my = hy + histH + 6;
    // background for motion area (clamped already by hy)
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(mx - 2, my - 2, histW + 4, motionH + 4);
    // draw motion polyline/arrows based on motionHistory (centroids)
    const mh = t.motionHistory || [];
    if(mh.length >= 2){
      // normalize centroids relative to the padded bbox center
      const cx = px + pw/2;
      const cy = py + ph/2;
      // map history points into motion area coordinates
      const N = mh.length;
      const pts = mh.map((pt, idx) => {
        const relX = (pt[0] - cx) / (pw/2 || 1); // -1..1
        const relY = (pt[1] - cy) / (ph/2 || 1); // -1..1
        const pxPos = mx + Math.round((idx/(N-1)) * Math.max(0, (histW - 2)));
        const pyPos = my + Math.round((motionH/2) * (1 - relY));
        return [pxPos, pyPos];
      });
      // draw colored segments based on speed between consecutive points
      const speeds = [];
      let maxSpeed = 0;
      for(let i=0;i<pts.length-1;i++){
        const p1 = pts[i], p2 = pts[i+1];
        const d = Math.hypot(p2[0]-p1[0], p2[1]-p1[1]);
        speeds.push(d);
        if(d > maxSpeed) maxSpeed = d;
      }
      // normalize using frame diagonal as reference if maxSpeed small
      const frameDiag = Math.hypot(overlay.width || 640, overlay.height || 480);
      const normRef = Math.max(maxSpeed, frameDiag/40); // avoid too small denom
      for(let i=0;i<pts.length-1;i++){
        const p1 = pts[i], p2 = pts[i+1];
        const norm = Math.min(1, speeds[i] / normRef);
        ctx.strokeStyle = speedToColor(norm);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
        // draw small dot at p1
        ctx.fillStyle = speedToColor(norm);
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(p1[0], p1[1], 2, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1.0;
      }
      // draw arrow at last vector and show normalized speed
      const a = pts[pts.length-2];
      const b = pts[pts.length-1];
      const lastSpeed = speeds[speeds.length-1] || 0;
      const lastNorm = Math.min(1, lastSpeed / normRef);
      drawArrow(ctx, a[0], a[1], b[0], b[1], 7);
      // speed label
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      const speedText = `v ${(lastNorm*100).toFixed(0)}%`;
      const tx = b[0] + 6; const ty = b[1] - 8;
      ctx.fillText(speedText, tx, ty);
    }
  }

  // Previously we drew a global legend in the bottom-left. Now we show per-track mini-legends.
  // Hide the HTML legend buttons (they are no longer needed as global controls).
  try{
    const appBtn = document.getElementById('legend-btn-appearance');
    const speedBtn = document.getElementById('legend-btn-speed');
    if(appBtn) appBtn.style.display = 'none';
    if(speedBtn) speedBtn.style.display = 'none';
  }catch(e){/* ignore */}

  // --- Proximity / Grouping visualization and event detection ---
  // Debug / explainable overlays: predicted boxes, assignment lines, per-pair scores, unmatched highlights
  try{
    if(debugVisuals && tracker && tracker.lastMatches){
      ctx.save();
      // small on-canvas legend (top-left)
      try{
        const lang = document.body.classList.contains('lang-en') ? 'en' : 'de';
        const L = {
          pred: lang==='en' ? 'Prediction' : 'Vorhersage',
          match: lang==='en' ? 'Match' : 'Zuordnung',
          udet: lang==='en' ? 'Unmatched Det.' : 'Unzugeordnete Det.',
          utrk: lang==='en' ? 'Unmatched Trk' : 'Unzugeordn. Trk',
          scores: lang==='en' ? 'Scores (IoU / Motion / App)' : 'Scores (IoU / Bewegung / Farbe)'
        };
        const lx = 8, ly = 8, lw = 220, lh = 84; ctx.fillStyle = 'rgba(0,0,0,0.45)'; roundRect(ctx, lx, ly, lw, lh, 8, true, true);
        ctx.font = '12px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(L.pred, lx + 36, ly + 10);
        // sample predicted dashed box
        ctx.setLineDash([6,3]); ctx.strokeStyle = 'rgba(255,215,0,0.95)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.rect(lx + 6, ly + 6, 18, 14); ctx.stroke(); ctx.setLineDash([]);
        // match line
        ctx.strokeStyle = 'rgba(180,200,255,0.9)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(lx + 12, ly + 34); ctx.lineTo(lx + 34, ly + 34); ctx.stroke(); ctx.fillStyle='#fff'; ctx.fillText(L.match, lx + 38, ly + 28);
        // unmatched detection box
        ctx.strokeStyle = 'rgba(255,200,60,0.95)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.rect(lx + 6, ly + 44, 18, 12); ctx.stroke(); ctx.fillStyle='#fff'; ctx.fillText(L.udet, lx + 36, ly + 42);
        // unmatched track dashed
        ctx.setLineDash([4,4]); ctx.strokeStyle = 'rgba(255,120,40,0.95)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.rect(lx + 6, ly + 60, 18, 12); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle='#fff'; ctx.fillText(L.utrk, lx + 36, ly + 58);
        // scores label
        ctx.font = '11px sans-serif'; ctx.fillStyle = '#ddd'; ctx.fillText(L.scores, lx + 8, ly + 76);
      }catch(e){/* ignore legend draw */}

      // draw predicted boxes for all tracks (dashed yellow)
      ctx.setLineDash([6,3]); ctx.lineWidth = 1.6;
      for(const tr of tracker.tracks){
        const pb = tr.lastBBox || [0,0,0,0]; ctx.strokeStyle = 'rgba(255,215,0,0.95)'; ctx.beginPath(); ctx.rect(pb[0], pb[1], pb[2], pb[3]); ctx.stroke();
      }
      ctx.setLineDash([]);

      // draw matches: line from detection centroid -> track predicted centroid, annotate IoU/Motion/App
      const lm = tracker.lastMatches;
      const dets = tracker.lastDetections || [];
      if(lm && Array.isArray(lm.matches)){
        ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
        for(const m of lm.matches){
          const tr = tracker.tracks[m.trackIndex];
          const det = dets[m.detIndex];
          if(!tr || !det) continue;
          const tC = bboxToCentroid(tr.lastBBox);
          const dC = bboxToCentroid(det.bbox);
          // compute component contributions for stacked bar and confidence
          const w_iou = tracker.match_weight_iou || 0.5;
          const w_motion = tracker.match_weight_motion || 0.3;
          const w_app = tracker.match_weight_app || 0.2;
          const ciou = w_iou * (m.iou || 0);
          const cmotion = w_motion * Math.max(0, 1 - (m.distNorm || 0));
          const capp = w_app * (m.appSim || 0);
          const conf = Math.max(0, Math.min(1, ciou + cmotion + capp));

          // connection line with thickness/alpha by confidence
          ctx.strokeStyle = `rgba(170,200,255,${0.35 + 0.6*conf})`;
          ctx.lineWidth = 1 + 3*conf;
          ctx.beginPath(); ctx.moveTo(dC[0], dC[1]); ctx.lineTo(tC[0], tC[1]); ctx.stroke();

          // annotate textual scores near midpoint
          const mx = (dC[0] + tC[0]) / 2; const my = (dC[1] + tC[1]) / 2;
          const txt = `IoU:${Math.round(m.iou*100)}% M:${Math.round((1 - m.distNorm)*100)}% A:${Math.round(m.appSim*100)}%`;
          const tw = ctx.measureText(txt).width + 8;
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; roundRect(ctx, mx - 4, my - 12, tw, 18, 4, true, false);
          ctx.fillStyle = '#fff'; ctx.fillText(txt, mx, my);

          // stacked score bar below the text
          try{
            const barW = 84, barH = 10; const bx = mx - barW/2, by = my + 12;
            // compute raw parts (use positive contributions)
            const parts = [ciou, cmotion, capp];
            const sum = parts.reduce((s,v)=>s+v, 1e-6);
            const colors = ['#66cc66','#66a6ff','#b588ff']; // IoU, Motion, App
            let cursor = bx;
            for(let pi=0; pi<parts.length; pi++){
              const w = Math.max(1, Math.round(barW * (parts[pi] / sum)));
              ctx.fillStyle = colors[pi]; roundRect(ctx, cursor, by, w, barH, 2, true, false);
              cursor += w;
            }
            // outline + percent label
            ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; roundRect(ctx, bx, by, barW, barH, 3, false, true);
            const pct = Math.round(conf*100) + '%'; ctx.fillStyle = '#fff'; ctx.font='10px sans-serif'; ctx.fillText(pct, bx + barW + 8, by + barH/2 - 6);
          }catch(e){/* ignore small draw */}
        }
      }

      // highlight unmatched detections
      if(lm && lm.unmatchedDetections && lm.unmatchedDetections.length){
        for(const di of lm.unmatchedDetections){
          const d = dets[di]; if(!d) continue;
          const b = d.bbox; ctx.strokeStyle = 'rgba(255,200,60,0.95)'; ctx.lineWidth = 2; ctx.setLineDash([]);
          ctx.beginPath(); ctx.rect(b[0], b[1], b[2], b[3]); ctx.stroke();
        }
      }

      // highlight unmatched tracks (predicted bbox dashed orange)
      if(lm && lm.unmatchedTracks && lm.unmatchedTracks.length){
        ctx.setLineDash([4,4]); ctx.lineWidth = 2;
        for(const ti of lm.unmatchedTracks){
          const tr = tracker.tracks[ti]; if(!tr) continue;
          const b = tr.lastBBox; ctx.strokeStyle = 'rgba(255,120,40,0.95)'; ctx.beginPath(); ctx.rect(b[0], b[1], b[2], b[3]); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }catch(e){ /* ignore debug draw errors */ }
  try{
    const coords = active.map(t => ({ id: t.id, c: bboxToCentroid(t.lastBBox) }));
    // pairwise neighbor detection
    const neighbors = {};
    for(let i=0;i<coords.length;i++){
      for(let j=i+1;j<coords.length;j++){
        const a = coords[i], b = coords[j];
        const d = Math.hypot(a.c[0]-b.c[0], a.c[1]-b.c[1]);
        if(d <= proximity.threshold){
          neighbors[a.id] = neighbors[a.id] || new Set(); neighbors[a.id].add(b.id);
          neighbors[b.id] = neighbors[b.id] || new Set(); neighbors[b.id].add(a.id);
          // draw line between them (closer -> brighter)
          const norm = Math.max(0, Math.min(1, 1 - (d / proximity.threshold)));
          ctx.strokeStyle = `rgba(${Math.round(255*(1-norm))},${Math.round(255*norm)},${Math.round(200*norm)},0.9)`;
          ctx.lineWidth = 1 + norm*2;
          ctx.beginPath(); ctx.moveTo(a.c[0], a.c[1]); ctx.lineTo(b.c[0], b.c[1]); ctx.stroke();
        }
      }
    }

    // build groups from neighbor adjacency (connected components)
    const visited = new Set();
    const groups = [];
    const idToNode = {}; coords.forEach(c=>idToNode[c.id]=c);
    for(const node of coords){
      if(visited.has(node.id)) continue;
      // BFS
      const stack = [node.id]; const comp = [];
      while(stack.length){
        const cur = stack.pop(); if(visited.has(cur)) continue; visited.add(cur); comp.push(cur);
        const nb = neighbors[cur]; if(nb) for(const n of nb) if(!visited.has(n)) stack.push(n);
      }
      if(comp.length) groups.push(comp);
    }

    // Draw group hulls or bounding boxes for groups >= minGroupSize
    const newMembership = {};
    let gidCounter = proximity.nextGroupId;
    for(const comp of groups){
      for(const id of comp) newMembership[id] = null; // placeholder
    }
    // match to existing groups by overlapping members
    const existingGroups = Object.values(proximity.groups);
    const assigned = new Set();
    for(const comp of groups){
      if(comp.length < proximity.minGroupSize) continue;
      // try to find existing group with most overlap
      let bestMatch = null, bestOverlap = 0;
      for(const g of existingGroups){
        const inter = comp.filter(id=> g.members.includes(id)).length;
        if(inter > bestOverlap){ bestOverlap = inter; bestMatch = g; }
      }
      let gid;
      if(bestMatch && bestOverlap >= Math.max(1, Math.floor(comp.length/2))){
        gid = bestMatch.id; bestMatch.members = comp.slice();
      }else{
        gid = `G${gidCounter++}`;
        proximity.groups[gid] = { id: gid, members: comp.slice(), created: Date.now() };
        pushEvent(`Group ${gid} formed (${comp.length} people)`);
      }
      // draw bounding box for this group
      const points = comp.map(id=> idToNode[id].c);
      const xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
      const gx = Math.min(...xs)-8, gy = Math.min(...ys)-8, gw = Math.max(...xs)-gx+8, gh = Math.max(...ys)-gy+8;
      ctx.save(); ctx.fillStyle = 'rgba(0,128,200,0.08)'; ctx.strokeStyle = 'rgba(0,200,255,0.6)'; ctx.lineWidth = 1.4; roundRect(ctx, gx, gy, gw, gh, 8, true, true); ctx.restore();
      // group badge (bilingual)
      try{
        const lang = document.body.classList.contains('lang-en') ? 'en' : 'de';
        const labelText = lang === 'en' ? `Group ${gid} (${comp.length})` : `Gruppe ${gid} (${comp.length})`;
        ctx.font = '12px sans-serif';
        const labW = Math.round(ctx.measureText(labelText).width + 12);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(gx, gy - 20, labW, 18);
        ctx.fillStyle = '#fff'; ctx.fillText(labelText, gx + 6, gy - 18);
      }catch(e){ /* ignore */ }
      // record membership
      for(const id of comp) newMembership[id] = gid;
    }
    proximity.nextGroupId = gidCounter;

    // detect splits/joins by comparing newMembership with previous immediate membership
    const last = proximity.lastMembership || {};
    // Apply debounce/stabilization: only push events when a change persists for N frames
    const idsUnion = new Set([...Object.keys(last), ...Object.keys(newMembership)]);
    for(const id of idsUnion){
      const lastVal = last[id] || null;
      const newVal = newMembership[id] || null;
      const stableVal = proximity.stableMembership[id] || null;
      if(stableVal === newVal){
        // already stable, reset counter
        proximity.counters[id] = 0;
        continue;
      }
      // pending change: increment counter
      proximity.counters[id] = (proximity.counters[id] || 0) + 1;
      const needed = newVal ? proximity.joinFrames : proximity.leaveFrames;
      if(proximity.counters[id] >= needed){
        // accept change
        proximity.stableMembership[id] = newVal;
        proximity.counters[id] = 0;
        if(!stableVal && newVal){
          pushEvent(`${id} joined ${newVal}`);
        }else if(stableVal && newVal && stableVal !== newVal){
          pushEvent(`${id} moved ${stableVal}→${newVal}`);
        }else if(stableVal && !newVal){
          pushEvent(`${id} left ${stableVal}`);
        }
      }
    }
    // update lastMembership to immediate view
    proximity.lastMembership = newMembership;
  }catch(e){ /* ignore proximity errors */ }
}

// Small helper to draw an arrow head
function drawArrow(ctx, x1, y1, x2, y2, size){
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.fillStyle = '#FFD700';
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI/6), y2 - size * Math.sin(angle - Math.PI/6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI/6), y2 - size * Math.sin(angle + Math.PI/6));
  ctx.closePath();
  ctx.fill();
}

// Detection + tracking loop
async function detectionLoop(){
  if(!running) return;
  if(!model) return;

  // Perform detection at reduced frequency to lower CPU usage
  try{
    frameCounter = (frameCounter + 1);
    let personDetections = [];
    if(frameCounter % frameSkip === 0){
      const predictions = await model.detect(video);
        const persons = predictions.filter(p => p.class === 'person' && p.score > 0.4);
        // For each person detection, compute appearance histogram (fast small crop)
        for(const p of persons){
          const bbox = p.bbox;
          const app = getAppearanceHistogram(bbox);
          personDetections.push({ bbox: bbox, score: p.score, appearance: app });
        }
      // Update: run predict then update with detections
      tracker.predict();
      tracker.update(personDetections);
    }else{
      // Only predict (propagate tracks without new measurements)
      tracker.predict();
    }
    drawOverlay();
  }catch(err){
    console.error('Detection error', err);
  }

  // Request next frame. Using setTimeout-ish cadence to avoid saturating CPU.
  // We use requestAnimationFrame but skip frames by timer if necessary.
  requestAnimationFrame(detectionLoop);
}

// Resize overlay canvas to match video element size
function resizeOverlay(){
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  // Also synchronize video element display size (video element scales itself)
}

// Start camera and model
async function start(){
  startButton.disabled = true;
  statusLabel.textContent = 'Status: Lade Modell...';

  // Load COCO-SSD model if not loaded
  if(!model){
    try{
      // Use WebGL backend for faster inference when available
      if(tf && tf.setBackend){
        try{ await tf.setBackend('webgl'); }catch(e){}
        await tf.ready();
      }
      model = await cocoSsd.load();
    }catch(err){
      console.error('Modell-Ladefehler', err);
      statusLabel.textContent = 'Fehler beim Laden des Modells';
      startButton.disabled = false;
      return;
    }
  }

  statusLabel.textContent = 'Status: Zugriff auf Kamera anfordern...';

  // Request webcam using the currently selected facing mode.
  // `facingMode` is 'user' or 'environment'.
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingMode }, audio: false });
    video.srcObject = stream;
  }catch(err){
    console.error('Kamera Fehler', err);
    statusLabel.textContent = 'Kamera-Zugriff verweigert oder nicht verfügbar';
    startButton.disabled = false;
    return;
  }

  // When video metadata is ready, size canvas and start detection loop
  await new Promise(resolve => { video.onloadedmetadata = resolve; });
  resizeOverlay();

  // Handle window resize to adapt overlay
  window.addEventListener('resize', resizeOverlay);

  // Enable stop button
  stopButton.disabled = false;
  statusLabel.textContent = 'Status: Erkennung läuft';
  running = true;

  // Start loop
  frameCounter = 0;
  detectionLoop();
}

function stop(){
  running = false;
  startButton.disabled = false;
  stopButton.disabled = true;
  statusLabel.textContent = 'Status: Gestoppt';

  // Stop video tracks
  if(stream){
    for(const track of stream.getTracks()) track.stop();
    stream = null;
  }

  // Clear tracks and overlay
  tracker.tracks = [];
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0,0,overlay.width, overlay.height);
}

// Wire up buttons
startButton.addEventListener('click', () => { start(); });
stopButton.addEventListener('click', () => { stop(); });

// Wire up facing mode select: when changed, update `facingMode` and restart stream if running.
if(facingSelect){
  // Initialize select to default
  facingSelect.value = facingMode;
  // Disable selection initially so laptop front camera is used for first tests
  facingSelect.disabled = true;
  facingSelect.addEventListener('change', async (ev) =>{
    const newMode = facingSelect.value;
    // Update desired facing mode
    facingMode = newMode;
    // If detection is running, restart camera with new facing mode
    if(running){
      statusLabel.textContent = 'Status: Kamera wechselt...';
      stop();
      // small delay to ensure tracks are closed
      setTimeout(() => { start(); }, 250);
    }
  });
}

// Settings UI wiring
const maxAgeEl = document.getElementById('maxAge');
const maxAgeVal = document.getElementById('maxAgeVal');
const iouEl = document.getElementById('iouThresh');
const iouVal = document.getElementById('iouVal');
const minHitsEl = document.getElementById('minHits');
const minHitsVal = document.getElementById('minHitsVal');
const frameSkipEl = document.getElementById('frameSkip');
const frameSkipVal = document.getElementById('frameSkipVal');

function updateSettingsUI(){
  if(!tracker) return;
  tracker.max_age = Number(maxAgeEl.value);
  maxAgeVal.textContent = maxAgeEl.value;
  tracker.iou_threshold = Number(iouEl.value)/100.0;
  iouVal.textContent = (Number(iouEl.value)/100).toFixed(2);
  tracker.min_hits = Number(minHitsEl.value);
  minHitsVal.textContent = minHitsEl.value;
  frameSkip = Number(frameSkipEl.value);
  frameSkipVal.textContent = frameSkipEl.value;
}

if(maxAgeEl){ maxAgeEl.addEventListener('input', updateSettingsUI); }
if(iouEl){ iouEl.addEventListener('input', updateSettingsUI); }
if(minHitsEl){ minHitsEl.addEventListener('input', updateSettingsUI); }
if(frameSkipEl){ frameSkipEl.addEventListener('input', updateSettingsUI); }
// initialize UI values
updateSettingsUI();

// Make the overlay follow video intrinsic size changes (e.g., mobile orientation)
video.addEventListener('loadeddata', resizeOverlay);

// Clean up on page hide
window.addEventListener('pagehide', () => { if(running) stop(); });

// Helpful: try to resume camera if autoplay blocked
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && running && video.paused){ video.play().catch(()=>{}); } });

// -------------------------
// Internationalization & Tooltip support (desktop hover + mobile tap)
// -------------------------

// Create tooltip element
const tooltipEl = document.createElement('div');
tooltipEl.id = 'tooltip';
tooltipEl.className = 'tooltip';
document.body.appendChild(tooltipEl);
let tooltipTimeout = null;

function showTooltipFor(elem, clientX, clientY){
  const lang = document.body.classList.contains('lang-en') ? 'en' : 'de';
  const txt = elem.dataset ? (lang === 'en' ? (elem.dataset.tooltipEn || '') : (elem.dataset.tooltipDe || '')) : '';
  if(!txt) return;
  tooltipEl.textContent = txt;
  // Position near pointer, but clamp to viewport
  const pad = 10;
  const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  let left = clientX + 12;
  let top = clientY + 12;
  const rect = tooltipEl.getBoundingClientRect();
  // if tooltip would overflow right edge, move left
  if(left + rect.width + pad > vw) left = Math.max(pad, clientX - rect.width - 12);
  if(top + rect.height + pad > vh) top = Math.max(pad, clientY - rect.height - 12);
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
  tooltipEl.classList.add('visible');
  if(tooltipTimeout) clearTimeout(tooltipTimeout);
  // auto-hide after 3.5s on tap
  tooltipTimeout = setTimeout(()=>{ hideTooltip(); }, 3500);
}

function hideTooltip(){
  tooltipEl.classList.remove('visible');
  if(tooltipTimeout){ clearTimeout(tooltipTimeout); tooltipTimeout = null; }
}

// Attach tooltip handlers to any element with data-tooltip-de or data-tooltip-en
function attachTooltips(){
  const elems = document.querySelectorAll('[data-tooltip-de], [data-tooltip-en]');
  elems.forEach(el => {
    // mouse hover for desktop
    el.addEventListener('mouseenter', (ev)=>{ showTooltipFor(el, ev.clientX, ev.clientY); });
    el.addEventListener('mousemove', (ev)=>{ showTooltipFor(el, ev.clientX, ev.clientY); });
    el.addEventListener('mouseleave', ()=>{ hideTooltip(); });
    // touch support: single tap toggles tooltip
    el.addEventListener('touchend', (ev)=>{
      ev.preventDefault();
      const t = ev.changedTouches[0];
      if(tooltipEl.classList.contains('visible')){ hideTooltip(); }
      else{ showTooltipFor(el, t.clientX, t.clientY); }
    }, {passive:false});
  });
}

// Initialize language selector and visibility
function initLanguage(){
  const sel = document.getElementById('langSelect');
  // default to German as page is in German
  const defaultLang = 'en';
  document.body.classList.add(`lang-${defaultLang}`);
  if(sel){
    sel.value = defaultLang;
    sel.addEventListener('change', (ev)=>{
      const v = sel.value === 'en' ? 'en' : 'de';
      document.body.classList.remove('lang-en','lang-de');
      document.body.classList.add(`lang-${v}`);
    });
  }
  // attach tooltips after language init
  attachTooltips();
}

// call initLanguage once DOM is ready (script loads after DOM) -- safe
initLanguage();
