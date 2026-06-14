/* Browser WebSocket client for local TouchDesigner integration. */

// TouchDesigner WebSocket DAT should listen on this local URL/port.
// This stays fully offline when Browser and TouchDesigner run on the same computer.
const TOUCHDESIGNER_WS_URL = 'ws://127.0.0.1:9980';
let touchDesignerSocket = null;
let touchDesignerReconnectTimer = null;
let lastTouchDesignerSend = 0;

function connectTouchDesignerSocket(){
  if(touchDesignerSocket && (
    touchDesignerSocket.readyState === WebSocket.OPEN ||
    touchDesignerSocket.readyState === WebSocket.CONNECTING
  )){
    return;
  }

  try{
    const socket = new WebSocket(TOUCHDESIGNER_WS_URL);
    touchDesignerSocket = socket;

    socket.addEventListener('open', () => {
      console.log(`TouchDesigner WebSocket connected: ${TOUCHDESIGNER_WS_URL}`);
      sendTouchDesignerPayload({
        type: 'hello',
        source: 'phonecam-browser',
        timestamp: Date.now(),
        message: 'Phonecam tracking stream connected'
      });
    });

    socket.addEventListener('close', (event) => {
      console.warn(
        `TouchDesigner WebSocket closed: code=${event.code}, reason="${event.reason || 'none'}", clean=${event.wasClean}`
      );
      if(touchDesignerSocket === socket) touchDesignerSocket = null;
      if(touchDesignerReconnectTimer) return;
      touchDesignerReconnectTimer = setTimeout(() => {
        touchDesignerReconnectTimer = null;
        connectTouchDesignerSocket();
      }, 2000);
    });

    socket.addEventListener('error', () => {
      console.warn(`TouchDesigner WebSocket error while connecting to ${TOUCHDESIGNER_WS_URL}`);
    });
  }catch(err){
    console.warn('Could not create TouchDesigner WebSocket', err);
  }
}

function sendTouchDesignerPayload(payload){
  if(!touchDesignerSocket || touchDesignerSocket.readyState !== WebSocket.OPEN) return;
  touchDesignerSocket.send(JSON.stringify(payload));
}

function sendTouchDesignerEvent(text, date){
  const ts = date || new Date();
  sendTouchDesignerPayload({
    type: 'event',
    source: 'phonecam-browser',
    timestamp: ts.getTime(),
    timeZurich: ts.toLocaleString('de-CH', {
      timeZone: 'Europe/Zurich',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short'
    }),
    text
  });
}

function getTrackTransportState(track){
  const eventState = trackEvents && trackEvents.states ? trackEvents.states[track.id] : null;
  const bbox = track.lastBBox || [0, 0, 0, 0];
  const centroid = bboxToCentroid(bbox);
  const speed = typeof trackSpeedNorm === 'function' ? trackSpeedNorm(track) : 0;
  const observedMs = eventState && eventState.seenAt ? Date.now() - eventState.seenAt : 0;
  const stillMs = eventState && eventState.stillSince ? Date.now() - eventState.stillSince : 0;
  const colorSummary = track.appearanceSummary || {};
  const redScore = typeof getAppearanceBucketScore === 'function'
    ? getAppearanceBucketScore(track.appearance, 'Red')
    : 0;

  return {
    id: track.id,
    x: overlay.width ? centroid[0] / overlay.width : 0,
    y: overlay.height ? centroid[1] / overlay.height : 0,
    px: Math.round(centroid[0]),
    py: Math.round(centroid[1]),
    bbox: {
      x: Math.round(bbox[0]),
      y: Math.round(bbox[1]),
      w: Math.round(bbox[2]),
      h: Math.round(bbox[3])
    },
    speed,
    moving: !!(eventState && eventState.moving),
    observedMs,
    stillMs,
    color: colorSummary.name || 'Unknown',
    colorConfidence: colorSummary.confidence || 0,
    redScore,
    redActive: redScore >= 0.30,
    colorRgb: colorSummary.rgb || null
  };
}

function sendTouchDesignerTracking(activeTracks){
  const now = performance.now();
  if(now - lastTouchDesignerSend < 100) return;
  lastTouchDesignerSend = now;

  sendTouchDesignerPayload({
    type: 'tracking',
    source: 'phonecam-browser',
    timestamp: Date.now(),
    count: activeTracks.length,
    width: overlay.width || 0,
    height: overlay.height || 0,
    tracks: activeTracks.map(getTrackTransportState)
  });
}

connectTouchDesignerSocket();
