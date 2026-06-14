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
  missingFramesLimit: 45,
  dwellLimitMs: 120000,
  zoneDwellMs: 18000,
  slowMoveMs: 8000
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

function trackZone(track){
  const bbox = track.lastBBox || [0, 0, 0, 0];
  const centroid = bboxToCentroid(bbox);
  const x = overlay.width ? centroid[0] / overlay.width : 0.5;
  if(x < 0.33) return 'LINKS';
  if(x > 0.66) return 'RECHTS';
  return 'MITTE';
}

function dwellScoreForState(state){
  if(!state || !state.seenAt) return 0;
  return Math.max(0, Math.min(1, (Date.now() - state.seenAt) / trackEvents.dwellLimitMs));
}

function escalationForScore(score){
  if(score >= 0.85) return 4;
  if(score >= 0.60) return 3;
  if(score >= 0.35) return 2;
  if(score >= 0.15) return 1;
  return 0;
}

function burnInForState(state){
  const dwellScore = dwellScoreForState(state);
  const stillBoost = state && state.stillSince
    ? Math.min(0.35, (Date.now() - state.stillSince) / 60000)
    : 0;
  return Math.max(0, Math.min(1, dwellScore + stillBoost));
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
        zone: null,
        zoneSince: null,
        zoneDwellLogged: false,
        slowSince: null,
        slowLogged: false,
        lastDwellMilestone: 0,
        escalation: 0,
        returnedLogged: false,
        intentLogged: false,
        loiterLogged: false,
        lastColor: null
      };
      trackEvents.states[t.id] = state;
      pushEvent(`${t.id} erfasst`);
    }

    if(trackEvents.missingFrames[t.id] > 0){
      pushEvent(`${t.id} kehrt zurück nach ${formatDuration(trackEvents.missingFrames[t.id] * 1000 / 30)} Abwesenheit`);
    }
    trackEvents.missingFrames[t.id] = 0;
    const speed = trackSpeedNorm(t);
    const zone = trackZone(t);
    if(zone !== state.zone){
      state.zone = zone;
      state.zoneSince = Date.now();
      state.zoneDwellLogged = false;
      pushEvent(`${t.id} betritt Zone ${zone}`);
    }else if(state.zoneSince && !state.zoneDwellLogged && Date.now() - state.zoneSince >= trackEvents.zoneDwellMs){
      state.zoneDwellLogged = true;
      pushEvent(`${t.id} verweilt in Zone ${zone} seit ${formatDuration(Date.now() - state.zoneSince)}`);
      if(zone === 'MITTE'){
        pushEvent(`${t.id} überschreitet Beobachtungsdauer in Zone MITTE`);
      }
    }

    const observedMs = Date.now() - state.seenAt;
    const observedMilestones = [10, 30, 60, 120];
    for(const milestone of observedMilestones){
      if(observedMs >= milestone * 1000 && state.lastDwellMilestone < milestone){
        state.lastDwellMilestone = milestone;
        pushEvent(`${t.id} ist sichtbar seit ${formatDuration(observedMs)}`);
        break;
      }
    }

    const dwellScore = dwellScoreForState(state);
    const escalation = escalationForScore(dwellScore);
    if(escalation > state.escalation){
      state.escalation = escalation;
      const labels = ['registriert', 'beobachtet', 'auffällig', 'kritisch'];
      pushEvent(`${t.id} Dwell Score Stufe ${escalation}: ${labels[escalation - 1]}`);
    }

    if(speed >= trackEvents.moveThreshold){
      state.moveFrames++;
      state.stopFrames = 0;
      state.stillFrames = 0;
      if(speed < trackEvents.moveThreshold * 1.8){
        if(!state.slowSince) state.slowSince = Date.now();
        if(!state.slowLogged && Date.now() - state.slowSince >= trackEvents.slowMoveMs){
          state.slowLogged = true;
          pushEvent(`${t.id} bewegt sich langsam seit ${formatDuration(Date.now() - state.slowSince)}`);
          pushEvent(`${t.id} Bewegungsabsicht unklar`);
        }
      }else{
        state.slowSince = null;
        state.slowLogged = false;
      }
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
      state.slowSince = null;
      state.slowLogged = false;
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
        pushEvent(`${t.id} Spur brennt sich ein`);
        if(zone === 'MITTE'){
          pushEvent(`${t.id} scheint Objekt zu beobachten`);
        }
      }
    }else{
      state.moveFrames = 0;
      state.stopFrames = 0;
      if(state.zone === 'MITTE' && state.stillSince && Date.now() - state.stillSince > 6000 && !state.intentLogged){
        state.intentLogged = true;
        pushEvent(`${t.id} Bewegungsabsicht unklar`);
        pushEvent(`${t.id} scheint Objekt zu beobachten`);
      }
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
