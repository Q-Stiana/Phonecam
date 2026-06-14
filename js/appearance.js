/* Appearance/color histogram extraction for tracked people. */

// --- Appearance (color histogram) helpers ---
// Offscreen canvas for cropping the video frames for appearance extraction
const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');
const APP_BINS = 16; // hue bins

const COLOR_BUCKETS = [
  { name: 'Black', neutral: 'black', rgb: [20, 20, 20] },
  { name: 'White', neutral: 'white', rgb: [238, 238, 238] },
  { name: 'Red', bins: [15, 0], hue: 0.0 },
  { name: 'Orange', bins: [1, 2], hue: 0.08 },
  { name: 'Yellow', bins: [3], hue: 0.16 },
  { name: 'Green', bins: [4, 5, 6], hue: 0.33 },
  { name: 'Cyan', bins: [7, 8], hue: 0.50 },
  { name: 'Blue', bins: [9, 10], hue: 0.62 },
  { name: 'Purple', bins: [11, 12], hue: 0.75 },
  { name: 'Magenta', bins: [13, 14], hue: 0.88 }
];

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

function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const d = max - min;
  let h = 0;
  if(d !== 0){
    if(max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if(max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function scaleBboxToOverlay(bbox){
  const sourceW = video.videoWidth || overlay.width || 1;
  const sourceH = video.videoHeight || overlay.height || 1;
  const sx = (overlay.width || sourceW) / sourceW;
  const sy = (overlay.height || sourceH) / sourceH;
  const [x,y,w,h] = bbox;
  return [x * sx, y * sy, w * sx, h * sy];
}

// Compute normalized hue histogram for a bbox in the original video coordinate space.
function getAppearanceHistogram(bbox){
  const videoW = video.videoWidth || video.width || 1;
  const videoH = video.videoHeight || video.height || 1;
  const [rawX, rawY, rawW, rawH] = bbox;
  // Focus on the central torso area. Full person boxes often include background,
  // floor, walls, and face/skin tones, which makes the color signature jumpy.
  const x = Math.max(0, Math.round(rawX + rawW * 0.22));
  const y = Math.max(0, Math.round(rawY + rawH * 0.28));
  const w = Math.max(1, Math.round(rawW * 0.56));
  const h = Math.max(1, Math.round(rawH * 0.38));
  const sx = Math.min(x, videoW - 1);
  const sy = Math.min(y, videoH - 1);
  const sw = Math.max(1, Math.min(w, videoW - sx));
  const sh = Math.max(1, Math.min(h, videoH - sy));
  // small crop size to reduce cost
  const CW = 80, CH = 80;
  cropCanvas.width = CW; cropCanvas.height = CH;
  try{
    // draw the bbox area from the video to the small canvas
    cropCtx.drawImage(video, sx, sy, sw, sh, 0, 0, CW, CH);
  }catch(e){
    // drawing can fail if video not ready
    return new Array(APP_BINS).fill(1/APP_BINS);
  }
  const img = cropCtx.getImageData(0,0,CW,CH).data;
  const hist = new Array(APP_BINS).fill(0);
  const backgroundHist = new Array(APP_BINS).fill(0);
  const backgroundNeutral = { black: 0, white: 0 };
  const backgroundRgb = { r: 0, g: 0, b: 0, count: 0 };
  const neutral = { black: 0, white: 0 };
  let backgroundCount = 0;
  let count = 0;

  function neutralClass(sat, val){
    if(val < 0.30) return 'black';
    if(val > 0.65 && sat < 0.25) return 'white';
    return null;
  }

  function addPixelToHist(target, r, g, b, a){
    if(a < 64) return false; // skip transparent-ish pixels
    const [hval, sat, val] = rgbToHsv(r,g,b);
    const neutralName = neutralClass(sat, val);
    if(neutralName) return neutralName;
    if(val < 0.08 || val > 0.96) return false; // ignore near-black and blown-out pixels
    if(sat < 0.18) return false; // ignore grey/white/black pixels, which have unstable hue
    const bin = Math.floor(hval * APP_BINS) % APP_BINS;
    target[bin] += 1;
    return true;
  }

  // Estimate likely background colors from the crop border. This is intentionally
  // simple and local: it removes wall/floor colors without needing another model.
  for(let py=0; py<CH; py++){
    for(let px=0; px<CW; px++){
      const border = px < 7 || px >= CW - 7 || py < 7 || py >= CH - 7;
      if(!border) continue;
      const i = (py * CW + px) * 4;
      const bgResult = addPixelToHist(backgroundHist, img[i], img[i+1], img[i+2], img[i+3]);
      if(bgResult){
        backgroundRgb.r += img[i];
        backgroundRgb.g += img[i+1];
        backgroundRgb.b += img[i+2];
        backgroundRgb.count++;
        if(bgResult === 'black' || bgResult === 'white') backgroundNeutral[bgResult]++;
        backgroundCount++;
      }
    }
  }
  if(backgroundCount > 0){
    for(let i=0;i<APP_BINS;i++) backgroundHist[i] /= backgroundCount;
    backgroundNeutral.black /= backgroundCount;
    backgroundNeutral.white /= backgroundCount;
  }
  const bgAvg = backgroundRgb.count > 0
    ? [backgroundRgb.r / backgroundRgb.count, backgroundRgb.g / backgroundRgb.count, backgroundRgb.b / backgroundRgb.count]
    : null;

  function contrastWeight(r, g, b){
    if(!bgAvg) return 1;
    const dist = Math.hypot(r - bgAvg[0], g - bgAvg[1], b - bgAvg[2]);
    const normalized = Math.max(0, Math.min(1, dist / 100));
    return 0.25 + normalized * 0.75;
  }

  for(let py=0; py<CH; py++){
    for(let px=0; px<CW; px++){
      const nx = (px + 0.5) / CW - 0.5;
      const ny = (py + 0.5) / CH - 0.5;
      const ellipse = (nx / 0.46) ** 2 + (ny / 0.52) ** 2;
      if(ellipse > 1) continue;

      const i = (py * CW + px) * 4;
      const r = img[i], g = img[i+1], b = img[i+2], a = img[i+3];
      if(a < 64) continue;
      const [hval, sat, val] = rgbToHsv(r,g,b);
      const weight = contrastWeight(r, g, b);
      const neutralName = neutralClass(sat, val);
      if(neutralName){
        const bgPenalty = Math.max(0.10, 1 - backgroundNeutral[neutralName]);
        const neutralWeight = weight * bgPenalty;
        neutral[neutralName] += neutralWeight;
        count += neutralWeight;
        continue;
      }
      if(val < 0.08 || val > 0.96) continue;
      if(sat < 0.18) continue;
      const bin = Math.floor(hval * APP_BINS) % APP_BINS;
      const bgPenalty = Math.max(0.20, 1 - backgroundHist[bin] * 2.2);
      const colorWeight = weight * bgPenalty;
      hist[bin] += colorWeight;
      count += colorWeight;
    }
  }
  if(count < 45){
    const emptyHist = new Array(APP_BINS).fill(1/APP_BINS);
    emptyHist.neutral = { black: 0, white: 0 };
    return emptyHist;
  }
  for(let i=0;i<APP_BINS;i++) hist[i] /= count; // normalize
  hist.neutral = {
    black: neutral.black / count,
    white: neutral.white / count
  };
  return hist;
}

function getAppearanceSummary(hist){
  if(!hist || !hist.length) return { name: 'Unknown', hue: 0, confidence: 0 };
  const scores = COLOR_BUCKETS.map(bucket => {
    const score = bucket.neutral
      ? ((hist.neutral && hist.neutral[bucket.neutral]) || 0)
      : bucket.bins.reduce((sum, bin) => sum + (hist[bin] || 0), 0);
    const hue = bucket.hue;
    return { name: bucket.name, hue, rgb: bucket.rgb, score };
  }).sort((a,b)=>b.score-a.score);
  const best = scores[0] || { name: 'Unknown', hue: 0, rgb: null, score: 0 };
  const second = scores[1] || { score: 0 };
  const confidence = Math.max(0, Math.min(1, best.score + Math.max(0, best.score - second.score)));
  return { name: best.name, hue: best.hue, rgb: best.rgb, confidence };
}

function getAppearanceBucketScore(hist, bucketName){
  if(!hist || !hist.length) return 0;
  const bucket = COLOR_BUCKETS.find(item => item.name === bucketName);
  if(!bucket) return 0;
  if(bucket.neutral){
    return (hist.neutral && hist.neutral[bucket.neutral]) || 0;
  }
  return bucket.bins.reduce((sum, bin) => sum + (hist[bin] || 0), 0);
}

function cloneAppearance(hist){
  if(!hist) return null;
  const clone = hist.slice();
  clone.neutral = {
    black: (hist.neutral && hist.neutral.black) || 0,
    white: (hist.neutral && hist.neutral.white) || 0
  };
  return clone;
}

function blendAppearance(current, next, alpha){
  if(!current) return cloneAppearance(next);
  for(let k=0;k<next.length;k++) current[k] = alpha*next[k] + (1-alpha)*current[k];
  current.neutral = current.neutral || { black: 0, white: 0 };
  const nextNeutral = next.neutral || { black: 0, white: 0 };
  current.neutral.black = alpha*nextNeutral.black + (1-alpha)*current.neutral.black;
  current.neutral.white = alpha*nextNeutral.white + (1-alpha)*current.neutral.white;
  return current;
}

// Bhattacharyya coefficient between two normalized histograms (0..1)
function bhattacharyya(a,b){
  if(!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for(let i=0;i<a.length;i++) s += Math.sqrt(a[i]*b[i]);
  return Math.max(0, Math.min(1, s));
}
