/* Event log and movement-state events. */

// Event log
const eventLog = { entries: [], max: 80 };
const eventListEl = document.getElementById('eventList');
const eventLogEl = document.getElementById('eventLog');
const clearLogBtn = document.getElementById('clearLog');
if(clearLogBtn){ clearLogBtn.addEventListener('click', ()=>{ eventLog.entries = []; renderEventLog(); }); }
let eventLogHover = false;

function setEventLogFullscreen(enabled){
  if(!eventLogEl) return;
  eventLogEl.classList.toggle('is-fullscreen', enabled);
}

if(eventLogEl){
  eventLogEl.addEventListener('mouseenter', ()=>{ eventLogHover = true; });
  eventLogEl.addEventListener('mouseleave', ()=>{ eventLogHover = false; });
  eventLogEl.addEventListener('dblclick', ()=>{ setEventLogFullscreen(!eventLogEl.classList.contains('is-fullscreen')); });
}

document.addEventListener('keydown', (ev)=>{
  if(!eventLogEl) return;
  const fullscreen = eventLogEl.classList.contains('is-fullscreen');
  if(ev.key === 'Escape' && fullscreen){
    setEventLogFullscreen(false);
    return;
  }
  const wantsToggle = ev.key.toLowerCase() === 'f' || ev.key.toLowerCase() === 'l' || ev.key === 'Enter';
  if(eventLogHover && wantsToggle){
    ev.preventDefault();
    setEventLogFullscreen(!fullscreen);
  }
});

function pushEvent(text){
  const ts = new Date();
  const entry = { t: ts, text };
  eventLog.entries.unshift(entry);
  if(eventLog.entries.length > eventLog.max) eventLog.entries.length = eventLog.max;
  renderEventLog();
  if(typeof sendTouchDesignerEvent === 'function') sendTouchDesignerEvent(text, ts);
  // optional narration for lay users
  if(narrationEnabled){ speakEvent(text); }
}

function renderEventLog(){
  if(!eventListEl) return;
  eventListEl.innerHTML = '';
  for(const e of eventLog.entries){
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className='time';
    time.textContent = e.t.toLocaleString('de-CH', {
      timeZone: 'Europe/Zurich',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short'
    });
    li.appendChild(time);
    li.appendChild(document.createTextNode(e.text));
    eventListEl.appendChild(li);
  }
}

const trackEvents = {
  states: {}, // trackId -> movement/event state
  seenIds: new Set(),
  missingFrames: {},
  moveThreshold: 0.018,
  stopThreshold: 0.008,
  movementFrames: 3,
  stopFrames: 8,
  loiterFrames: 90,
  missingFramesLimit: 45
};

function formatDuration(ms){
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${String(sec).padStart(2,'0')}s` : `${sec}s`;
}

function trackSpeedNorm(track){
  const mh = track.motionHistory || [];
  if(mh.length < 2) return 0;
  let total = 0;
  let samples = 0;
  const start = Math.max(1, mh.length - 5);
  const frameDiag = Math.hypot(overlay.width || 640, overlay.height || 480);
  for(let i=start; i<mh.length; i++){
    const a = mh[i-1], b = mh[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]) / frameDiag;
    samples++;
  }
  return samples ? total / samples : 0;
}

function updateTrackEventLog(activeTracks){
  const activeIds = new Set(activeTracks.map(t => t.id));

  for(const t of activeTracks){
    let state = trackEvents.states[t.id];
    if(!state){
      state = {
        moving: false,
        moveFrames: 0,
        stopFrames: 0,
        stillFrames: 0,
        seenAt: Date.now(),
        stillSince: null,
        lastStillMilestone: 0,
        loiterLogged: false,
        lastColor: null
      };
      trackEvents.states[t.id] = state;
      pushEvent(`${t.id} erfasst`);
    }

    trackEvents.missingFrames[t.id] = 0;
    const speed = trackSpeedNorm(t);

    if(speed >= trackEvents.moveThreshold){
      state.moveFrames++;
      state.stopFrames = 0;
      state.stillFrames = 0;
      if(!state.moving && state.moveFrames >= trackEvents.movementFrames){
        if(state.stillSince){
          pushEvent(`${t.id} bewegt sich weiter nach ${formatDuration(Date.now() - state.stillSince)} Stillstand`);
          state.stillSince = null;
          state.lastStillMilestone = 0;
        }
        state.moving = true;
        state.loiterLogged = false;
        pushEvent(`${t.id} startet Bewegung`);
      }
    }else if(speed <= trackEvents.stopThreshold){
      state.stopFrames++;
      state.moveFrames = 0;
      state.stillFrames++;
      if(state.moving && state.stopFrames >= trackEvents.stopFrames){
        state.moving = false;
        state.stillSince = Date.now();
        state.lastStillMilestone = 0;
        pushEvent(`${t.id} bleibt stehen`);
      }else if(!state.moving && !state.stillSince && state.stopFrames >= trackEvents.stopFrames){
        state.stillSince = Date.now();
        state.lastStillMilestone = 0;
      }
      if(state.stillSince){
        const stillSeconds = Math.floor((Date.now() - state.stillSince) / 1000);
        const milestones = [10, 30, 60, 120];
        for(const milestone of milestones){
          if(stillSeconds >= milestone && state.lastStillMilestone < milestone){
            state.lastStillMilestone = milestone;
            pushEvent(`${t.id} steht still seit ${formatDuration(stillSeconds * 1000)}`);
            break;
          }
        }
      }
      if(!state.loiterLogged && state.stillFrames >= trackEvents.loiterFrames){
        state.loiterLogged = true;
        const dwell = state.stillSince ? ` (${formatDuration(Date.now() - state.stillSince)} Stillstand)` : '';
        pushEvent(`${t.id} verweilt / loitering${dwell}`);
      }
    }else{
      state.moveFrames = 0;
      state.stopFrames = 0;
    }

    const color = t.appearanceSummary && t.appearanceSummary.name;
    if(color && color !== 'Unknown' && color !== state.lastColor){
      state.lastColor = color;
      pushEvent(`${t.id} Merkmal Farbe: ${color}`);
    }
  }

  for(const id of Object.keys(trackEvents.states)){
    if(activeIds.has(id)) continue;
    trackEvents.missingFrames[id] = (trackEvents.missingFrames[id] || 0) + 1;
    if(trackEvents.missingFrames[id] === trackEvents.missingFramesLimit){
      const observed = trackEvents.states[id] && trackEvents.states[id].seenAt
        ? ` nach ${formatDuration(Date.now() - trackEvents.states[id].seenAt)} Beobachtung`
        : '';
      pushEvent(`${id} verschwindet aus dem Sichtfeld${observed}`);
      delete trackEvents.states[id];
      delete trackEvents.missingFrames[id];
    }
  }
}
