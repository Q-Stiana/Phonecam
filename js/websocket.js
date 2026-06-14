/* Browser WebSocket client for local TouchDesigner integration. */

// TouchDesigner WebSocket DAT should listen on this local URL/port.
// This stays fully offline when Browser and TouchDesigner run on the same computer.
const TOUCHDESIGNER_WS_URL = 'ws://127.0.0.1:8001';
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
  const frameWidth = overlay.width || 1;
  const frameHeight = overlay.height || 1;
  const centroid = bboxToCentroid(bbox);
  const timestamp = Date.now();
  const dwellMs = eventState && eventState.seenAt ? timestamp - eventState.seenAt : timestamp - track.startTime;
  const speed = typeof trackSpeedNorm === 'function' ? trackSpeedNorm(track) : 0;
  const observedMs = eventState && eventState.seenAt ? timestamp - eventState.seenAt : 0;
  const stillMs = eventState && eventState.stillSince ? timestamp - eventState.stillSince : 0;
  const dwellScore = typeof dwellScoreForState === 'function' ? dwellScoreForState(eventState) : 0;
  const escalation = typeof escalationForScore === 'function' ? escalationForScore(dwellScore) : 0;
  const burnIn = typeof burnInForState === 'function' ? burnInForState(eventState) : 0;
  const groupId = proximity && proximity.stableMembership
    ? proximity.stableMembership[track.id] || null
    : null;
  const colorSummary = track.appearanceSummary || {};
  const redScore = typeof getAppearanceBucketScore === 'function'
    ? getAppearanceBucketScore(track.appearance, 'Red')
    : 0;
  const isSlow = !!(eventState && eventState.slowSince);
  const isLoitering = !!(eventState && eventState.loiterLogged);
  const interaction = groupId
    ? 'close_proximity'
    : (isLoitering ? 'loitering' : (isSlow ? 'unclear_motion' : 'none'));

  return {
    id: track.id,
    timestamp,
    x: centroid[0] / frameWidth,
    y: centroid[1] / frameHeight,
    w: bbox[2] / frameWidth,
    h: bbox[3] / frameHeight,
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
    zone: eventState && eventState.zone ? eventState.zone : 'UNKNOWN',
    observedMs,
    observedSeconds: Math.round(observedMs / 1000),
    stillMs,
    stillSeconds: Math.round(stillMs / 1000),
    dwellScore,
    escalation,
    burnIn,
    burnInActive: burnIn >= 0.45,
    groupId,
    inGroup: !!groupId,
    interaction,
    slowMovement: isSlow,
    loitering: isLoitering,
    color: colorSummary.name || 'Unknown',
    colorConfidence: colorSummary.confidence || 0,
    redScore,
    redActive: redScore >= 0.30,
    colorRgb: colorSummary.rgb || null,
    dwell: Math.max(0, dwellMs / 1000)
  };
}

function sendTouchDesignerTracking(activeTracks){
  const now = performance.now();
  const intervalMs = Math.max(16, Number(touchDesignerSendIntervalMs) || 100);
  if(now - lastTouchDesignerSend < intervalMs) return;
  lastTouchDesignerSend = now;

  sendTouchDesignerPayload({
    type: 'tracking',
    timestamp: Date.now(),
    count: activeTracks.length,
    width: overlay.width || 0,
    height: overlay.height || 0,
    people: activeTracks.map(getTrackTransportState)
  });
}

connectTouchDesignerSocket();
