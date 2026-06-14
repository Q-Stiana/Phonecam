/* SORT-like person tracker and assignment logic. */

// Tracker state
let nextId = 1; // counter for generating IDs
// We'll use a Tracker class (SORT-like): each Track contains a Kalman filter,
// a unique ID, and bookkeeping. The Tracker performs prediction, matching
// (IoU-based) and updates tracks, handling short occlusions and stable IDs.


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
    this.appearanceSummary = { name: 'Unknown', hue: 0, confidence: 0 };
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
    this.max_tracks = typeof MAX_TRACKED_PEOPLE !== 'undefined' ? MAX_TRACKED_PEOPLE : 10;
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
          if(!this.tracks[ti].appearance) this.tracks[ti].appearance = cloneAppearance(detApp);
          else{
            const mh = this.tracks[ti].motionHistory || [];
            let speedNorm = 0;
            if(mh.length >= 2){
              const a = mh[mh.length - 2];
              const b = mh[mh.length - 1];
              const frameDiag = Math.hypot(overlay.width || 640, overlay.height || 480);
              speedNorm = Math.min(1, Math.hypot(b[0] - a[0], b[1] - a[1]) / (frameDiag / 35));
            }
            const alpha = 0.08 + speedNorm * 0.22;
            this.tracks[ti].appearance = blendAppearance(this.tracks[ti].appearance, detApp, alpha);
          }
          this.tracks[ti].appearanceSummary = getAppearanceSummary(this.tracks[ti].appearance);
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

    // 5) Create new tracks for unmatched detections, capped for performance/readability
    this.tracks = this.tracks.filter(t => t.time_since_update <= this.max_age);
    const openSlots = Math.max(0, this.max_tracks - this.tracks.length);
    const strongestUnmatched = unmatchedDetections
      .map(dj => ({ dj, score: detections[dj] ? detections[dj].score || 0 : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, openSlots);
    for(const item of strongestUnmatched){
      const dj = item.dj;
      const det = detections[dj];
      const trk = new Track(det.bbox, `ID${this.nextId++}`);
      trk.appearance = cloneAppearance(det.appearance);
      trk.appearanceSummary = getAppearanceSummary(trk.appearance);
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
