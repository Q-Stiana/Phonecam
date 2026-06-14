/* Math, geometry, color, and canvas helpers. */

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

const SPEED_COLOR_STEPS = [
  { name: 'still', label: 'Stillstand', max: 0.08, color: '#B8C0CC' },
  { name: 'slow', label: 'Langsam', max: 0.25, color: '#00E5FF' },
  { name: 'normal', label: 'Normal', max: 0.55, color: '#7CFF6B' },
  { name: 'fast', label: 'Schnell', max: 0.82, color: '#FFD166' },
  { name: 'alert', label: 'Auffällig', max: 1.01, color: '#FF4D4D' }
];

function speedStepForNorm(norm){
  const t = Math.max(0, Math.min(1, norm));
  return SPEED_COLOR_STEPS.find(step => t <= step.max) || SPEED_COLOR_STEPS[SPEED_COLOR_STEPS.length - 1];
}

// Map normalized speed (0..1) to clear surveillance-like categories.
function speedToColor(norm){
  return speedStepForNorm(norm).color;
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
