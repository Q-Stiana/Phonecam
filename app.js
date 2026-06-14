/* Camera/model lifecycle, detection loop, controls, language, and tooltips. */

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
        const persons = predictions
          .filter(p => p.class === 'person' && p.score > 0.4)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_TRACKED_PEOPLE);
        // For each person detection, compute appearance histogram (fast small crop)
        for(const p of persons){
          const sourceBBox = p.bbox;
          const displayBBox = scaleBboxToOverlay(sourceBBox);
          const app = getAppearanceHistogram(sourceBBox);
          personDetections.push({ bbox: displayBBox, score: p.score, appearance: app });
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

function getVideoConstraints(){
  if(selectedCameraId){
    return { deviceId: { exact: selectedCameraId } };
  }
  if(facingMode === 'auto'){
    return true;
  }
  return { facingMode: facingMode };
}

async function requestCameraStream(){
  try{
    return await navigator.mediaDevices.getUserMedia({ video: getVideoConstraints(), audio: false });
  }catch(err){
    const hadSpecificSelection = !!selectedCameraId || facingMode !== 'auto';
    if(!hadSpecificSelection) throw err;
    console.warn('Gewählte Kamera nicht verfügbar, versuche automatische Kamera', err);
    selectedCameraId = '';
    facingMode = 'auto';
    if(facingSelect) facingSelect.value = 'auto';
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

async function refreshCameraOptions(){
  if(!facingSelect || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try{
    const currentValue = selectedCameraId ? `device:${selectedCameraId}` : facingMode;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(device => device.kind === 'videoinput');
    const options = [
      { value: 'auto', label: 'Automatische Kamera' },
      { value: 'user', label: 'Frontkamera (Laptop)' },
      { value: 'environment', label: 'Rückkamera' }
    ];
    cameras.forEach((camera, index) => {
      const label = camera.label || `Kamera ${index + 1}`;
      options.push({ value: `device:${camera.deviceId}`, label });
    });

    facingSelect.innerHTML = '';
    options.forEach(optionInfo => {
      const option = document.createElement('option');
      option.value = optionInfo.value;
      option.textContent = optionInfo.label;
      facingSelect.appendChild(option);
    });

    if(options.some(option => option.value === currentValue)){
      facingSelect.value = currentValue;
    }else{
      selectedCameraId = '';
      facingSelect.value = facingMode;
    }
  }catch(err){
    console.warn('Kameraliste konnte nicht gelesen werden', err);
  }
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
      model = await cocoSsd.load({ modelUrl: COCO_SSD_MODEL_URL });
    }catch(err){
      console.error('Modell-Ladefehler', err);
      statusLabel.textContent = 'Fehler beim Laden des Modells';
      startButton.disabled = false;
      return;
    }
  }

  statusLabel.textContent = 'Status: Zugriff auf Kamera anfordern...';

  // Request webcam using either the selected physical camera or facing mode.
  try{
    stream = await requestCameraStream();
    video.srcObject = stream;
    await refreshCameraOptions();
  }catch(err){
    console.error('Kamera Fehler', err);
    statusLabel.textContent = err && err.name === 'NotAllowedError'
      ? 'Kamera-Zugriff im Browser blockiert'
      : 'Kamera nicht verfügbar';
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
  statusLabel.textContent = 'Status: Erkennung lÃ¤uft';
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
  trackEvents.states = {};
  trackEvents.missingFrames = {};
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0,0,overlay.width, overlay.height);
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
if(debugToggleEl){
  debugToggleEl.addEventListener('change', ()=>{ debugVisuals = !!debugToggleEl.checked; });
}

// Novice mode, narration and heatmap toggles
const noviceToggleEl = document.getElementById('noviceToggle');
const narrationToggleEl = document.getElementById('narrationToggle');
const heatmapToggleEl = document.getElementById('heatmapToggle');
if(noviceToggleEl) noviceToggleEl.addEventListener('change', ()=>{ noviceMode = !!noviceToggleEl.checked; });
if(narrationToggleEl) narrationToggleEl.addEventListener('change', ()=>{ narrationEnabled = !!narrationToggleEl.checked; });
if(heatmapToggleEl) heatmapToggleEl.addEventListener('change', ()=>{ heatmapEnabled = !!heatmapToggleEl.checked; });

// Wire up buttons
startButton.addEventListener('click', () => { start(); });
stopButton.addEventListener('click', () => { stop(); });

// Wire up camera select: facing presets plus concrete devices after permission.
if(facingSelect){
  // Initialize select to default
  facingSelect.value = facingMode;
  refreshCameraOptions();
  facingSelect.addEventListener('change', async (ev) =>{
    const selectedValue = facingSelect.value;
    if(selectedValue.startsWith('device:')){
      selectedCameraId = selectedValue.slice('device:'.length);
    }else{
      selectedCameraId = '';
      facingMode = selectedValue;
    }
    // If detection is running, restart camera with the new camera selection.
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
const touchDesignerIntervalEl = document.getElementById('touchDesignerInterval');
const touchDesignerIntervalVal = document.getElementById('touchDesignerIntervalVal');

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
  if(touchDesignerIntervalEl){
    touchDesignerSendIntervalMs = Number(touchDesignerIntervalEl.value);
    if(touchDesignerIntervalVal) touchDesignerIntervalVal.textContent = touchDesignerIntervalEl.value;
  }
}

if(maxAgeEl){ maxAgeEl.addEventListener('input', updateSettingsUI); }
if(iouEl){ iouEl.addEventListener('input', updateSettingsUI); }
if(minHitsEl){ minHitsEl.addEventListener('input', updateSettingsUI); }
if(frameSkipEl){ frameSkipEl.addEventListener('input', updateSettingsUI); }
if(touchDesignerIntervalEl){ touchDesignerIntervalEl.addEventListener('input', updateSettingsUI); }
// initialize UI values
updateSettingsUI();

// Make the overlay follow video intrinsic size changes (e.g., mobile orientation)
video.addEventListener('loadeddata', resizeOverlay);

// Clean up on page hide
window.addEventListener('pagehide', () => { if(running) stop(); });

// Helpful: try to resume camera if autoplay blocked
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && running && video.paused){ video.play().catch(()=>{}); } });

// Fullscreen installation view: large live tracking image with Monitoring Log overlay.
const fullscreenButton = document.getElementById('fullscreenButton');
async function enterInstallationFullscreen(){
  document.body.classList.add('installation-fullscreen');
  try{
    if(document.documentElement.requestFullscreen && !document.fullscreenElement){
      await document.documentElement.requestFullscreen();
    }
  }catch(err){
    console.warn('Fullscreen request was blocked or unavailable', err);
  }
  setTimeout(resizeOverlay, 120);
}

function exitInstallationFullscreen(){
  document.body.classList.remove('installation-fullscreen');
  setTimeout(resizeOverlay, 120);
}

if(fullscreenButton){
  fullscreenButton.addEventListener('click', () => {
    if(document.fullscreenElement || document.body.classList.contains('installation-fullscreen')){
      if(document.exitFullscreen) document.exitFullscreen().catch(()=>{});
      exitInstallationFullscreen();
    }else{
      enterInstallationFullscreen();
    }
  });
}

document.addEventListener('fullscreenchange', () => {
  if(!document.fullscreenElement) exitInstallationFullscreen();
  else setTimeout(resizeOverlay, 120);
});

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
