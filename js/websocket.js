/* Browser WebSocket client for local TouchDesigner integration. */

// TouchDesigner WebSocket DAT should listen on this local URL/port.
// This stays fully offline when Browser and TouchDesigner run on the same computer.
const TOUCHDESIGNER_WS_URL = 'ws://127.0.0.1:8001';
let touchDesignerSocket = null;
let touchDesignerReconnectTimer = null;
let lastTouchDesignerSend = 0;

const TOUCHDESIGNER_ID_FUNCTIONS = [
  { id: 1, name: 'red_filter', label: 'Red filter from clothing color' },
  { id: 2, name: 'burn_in_trace', label: 'Loitering burn-in trace' },
  { id: 3, name: 'dwell_escalation', label: 'Dwell score / escalation' },
  { id: 4, name: 'motion_speed', label: 'Motion speed distortion' },
  { id: 5, name: 'nervous_glitch', label: 'Nervous movement glitch' },
  { id: 6, name: 'direction_flow', label: 'Directional flow field' },
  { id: 7, name: 'center_approach', label: 'Approaching center trigger' },
  { id: 8, name: 'proximity_lines', label: 'Group / proximity lines' },
  { id: 9, name: 'tracking_uncertainty', label: 'Predicted / occluded ghosting' },
  { id: 10, name: 'zone_mask', label: 'Zone-based mask or filter' }
];

function numericIdForTrack(trackId){
  const match = String(trackId).match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

function touchDesignerFunctionForTrack(trackId, state){
  const numericId = numericIdForTrack(trackId);
  const assignment = TOUCHDESIGNER_ID_FUNCTIONS[(Math.max(1, numericId) - 1) % TOUCHDESIGNER_ID_FUNCTIONS.length];
  let value = 0;
  let active = false;

  if(assignment.name === 'red_filter'){
    value = state.redScore;
    active = state.redActive;
  }else if(assignment.name === 'burn_in_trace'){
    value = state.burnIn;
    active = state.burnInActive;
  }else if(assignment.name === 'dwell_escalation'){
    value = Math.max(state.dwellScore, state.escalation / 4);
    active = state.escalation >= 1;
  }else if(assignment.name === 'motion_speed'){
    value = Math.max(0, Math.min(1, state.speed * 18));
    active = state.moving;
  }else if(assignment.name === 'nervous_glitch'){
    value = state.instability;
    active = state.nervous;
  }else if(assignment.name === 'direction_flow'){
    value = Math.max(0, Math.min(1, Math.hypot(state.directionX, state.directionY) * 18));
    active = state.direction !== 'unknown' && state.direction !== 'unclear';
  }else if(assignment.name === 'center_approach'){
    value = state.approachingCenter ? 1 : 0;
    active = state.approachingCenter;
  }else if(assignment.name === 'proximity_lines'){
    value = state.inGroup ? 1 : 0;
    active = state.inGroup;
  }else if(assignment.name === 'tracking_uncertainty'){
    value = state.predicted ? 1 : 1 - state.visibilityRatio;
    active = state.predicted || state.visibilityState === 'reduced';
  }else if(assignment.name === 'zone_mask'){
    value = state.zone === 'MITTE' ? 1 : (state.zone === 'LINKS' || state.zone === 'RECHTS' ? 0.5 : 0);
    active = state.zone !== 'UNKNOWN';
  }

  return {
    slot: assignment.id,
    name: assignment.name,
    label: assignment.label,
    value: Math.max(0, Math.min(1, value || 0)),
    active
  };
}

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
  const motionIntent = typeof trackMotionIntent === 'function' ? trackMotionIntent(track) : null;
  const motionState = typeof trackMotionState === 'function'
    ? trackMotionState(speed, motionIntent)
    : { name: 'unknown', label: 'unklar', color: '#FFFFFF' };
  const boxArea = typeof trackBoxArea === 'function' ? trackBoxArea(track) : ((bbox[2] || 0) * (bbox[3] || 0));
  const visibilityRatio = eventState && eventState.maxBoxArea
    ? Math.max(0, Math.min(1, boxArea / eventState.maxBoxArea))
    : 1;
  const predicted = typeof trackEvents !== 'undefined'
    ? track.time_since_update >= trackEvents.predictedFrames
    : track.time_since_update > 0;
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
  const tdState = {
    speed,
    motionState: motionState.name,
    predicted,
    visibilityRatio,
    visibilityState: eventState && eventState.visibilityState ? eventState.visibilityState : 'clear',
    direction: motionIntent ? motionIntent.direction : 'unknown',
    directionX: motionIntent ? motionIntent.dx : 0,
    directionY: motionIntent ? motionIntent.dy : 0,
    approachingCenter: !!(motionIntent && motionIntent.approachingCenter),
    instability: motionIntent ? motionIntent.instability : 0,
    nervous: !!(motionIntent && motionIntent.nervous),
    moving: !!(eventState && eventState.moving),
    zone: eventState && eventState.zone ? eventState.zone : 'UNKNOWN',
    dwellScore,
    escalation,
    burnIn,
    burnInActive: burnIn >= 0.45,
    inGroup: !!groupId,
    redScore,
    redActive: redScore >= 0.30
  };
  const tdFunction = touchDesignerFunctionForTrack(track.id, tdState);

  return {
    id: track.id,
    tdFunctionSlot: tdFunction.slot,
    tdFunctionName: tdFunction.name,
    tdFunctionLabel: tdFunction.label,
    tdFunctionValue: tdFunction.value,
    tdFunctionActive: tdFunction.active,
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
    motionState: motionState.name,
    motionStateLabel: motionState.label,
    motionColor: motionState.color,
    predicted,
    visibilityRatio,
    visibilityState: eventState && eventState.visibilityState ? eventState.visibilityState : 'clear',
    direction: motionIntent ? motionIntent.direction : 'unknown',
    directionText: motionIntent ? motionIntent.directionText : 'unklar',
    directionX: motionIntent ? motionIntent.dx : 0,
    directionY: motionIntent ? motionIntent.dy : 0,
    approachingCenter: !!(motionIntent && motionIntent.approachingCenter),
    leavingCenter: !!(motionIntent && motionIntent.leavingCenter),
    instability: motionIntent ? motionIntent.instability : 0,
    nervous: !!(motionIntent && motionIntent.nervous),
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
