/* Canvas overlay rendering for tracks, groups, debug visuals, and heatmap. */

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
    const neutralBars = 2;
    const histW = (bins + neutralBars) * barW;
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
      const neutralVals = [
        { val: (t.appearance.neutral && t.appearance.neutral.black) || 0, rgb: [20,20,20], stroke: 'rgba(255,255,255,0.55)' },
        { val: (t.appearance.neutral && t.appearance.neutral.white) || 0, rgb: [238,238,238], stroke: 'rgba(0,0,0,0.7)' }
      ];
      for(let i=0;i<neutralVals.length;i++){
        const item = neutralVals[i];
        const bh = Math.max(1, Math.round(item.val * histH));
        const bx = hx + i*barW;
        const by = hy + (histH - bh);
        ctx.fillStyle = `rgb(${item.rgb[0]},${item.rgb[1]},${item.rgb[2]})`;
        ctx.fillRect(bx, by, barW - 1, bh);
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, barW - 1, bh);
      }
      for(let i=0;i<bins;i++){
        const val = t.appearance[i] || 0;
        const hcol = i / bins; // hue
        const rgb = hsvToRgb(hcol, 1, 0.8);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        const bw = barW - 1;
        const bh = Math.max(1, Math.round(val * histH));
        const bx = hx + (i + neutralBars)*barW;
        const by = hy + (histH - bh);
        ctx.fillRect(bx, by, bw, bh);
      }
      // Dominant color swatch + percent (most intuitive summary for viewers)
      try{
        const summary = t.appearanceSummary || getAppearanceSummary(t.appearance);
        const hue = summary.hue || 0;
        const swSize = Math.max(12, Math.round(histH));
        let swX = hx + histW + 8;
        const swY = hy;
        if(swX + swSize + 40 > overlay.width) swX = hx - swSize - 8; // place left if not enough space
        const rgb = summary.rgb || hsvToRgb(hue, 1, 0.85);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(swX, swY, swSize, swSize);
        if(summary.name === 'White'){
          ctx.strokeStyle = 'rgba(0,0,0,0.65)';
          ctx.lineWidth = 1;
          ctx.strokeRect(swX, swY, swSize, swSize);
        }
        // text label
        const name = summary.name || 'Unknown';
        const pct = Math.round((summary.confidence || 0) * 100);
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

  updateTrackEventLog(active);

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
        pushEvent(`Gruppe ${gid} gebildet (${comp.length} IDs)`);
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
          pushEvent(`${id} trifft ${newVal} (close proximity)`);
          pushEvent(`${id} scheint mit einer Person zu sprechen`);
        }else if(stableVal && newVal && stableVal !== newVal){
          pushEvent(`${id} wechselt von ${stableVal} zu ${newVal}`);
        }else if(stableVal && !newVal){
          pushEvent(`${id} entfernt sich von ${stableVal}`);
        }
      }
    }
    // update lastMembership to immediate view
    proximity.lastMembership = newMembership;
  }catch(e){ /* ignore proximity errors */ }

  sendTouchDesignerTracking(active);
}
