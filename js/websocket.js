/* Browser WebSocket client for the local TouchDesigner relay. */

// Local relay server. Browser and TouchDesigner both connect to this as clients.
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
      sendTouchDesignerPayload({ type: 'hello', source: 'phonecam-browser', dummy: true });
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

function sendTouchDesignerTracking(activeTracks){
  const now = performance.now();
  if(now - lastTouchDesignerSend < 250) return;
  lastTouchDesignerSend = now;

  sendTouchDesignerPayload({
    type: 'tracking',
    source: 'phonecam-browser',
    dummy: true,
    timestamp: Date.now(),
    count: activeTracks.length,
    tracks: activeTracks.map(track => {
      const bbox = track.lastBBox || [0, 0, 0, 0];
      const centroid = bboxToCentroid(bbox);
      return {
        id: track.id,
        x: Math.round(centroid[0]),
        y: Math.round(centroid[1]),
        bbox: bbox.map(value => Math.round(value))
      };
    })
  });
}

connectTouchDesignerSocket();
