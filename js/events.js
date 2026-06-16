/* Event log and movement-state events. */

// Event log
const eventLog = { entries: [], max: 80, perIdIntervalMs: 3000, lastById: {} };
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

function eventTrackId(text){
  const match = String(text).match(/\bID\d+\b/);
  return match ? match[0] : null;
}

function pushEvent(text){
  const ts = new Date();
  const id = eventTrackId(text);
  if(id){
    const last = eventLog.lastById[id] || 0;
    if(ts.getTime() - last < eventLog.perIdIntervalMs) return;
    eventLog.lastById[id] = ts.getTime();
  }
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
  slowMoveMs: 8000,
  directionLogMs: 5000,
  nervousLogMs: 18000,
  speedLogMs: 4000,
  predictedFrames: 6,
  visibilityLogMs: 5000
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

function trackMotionIntent(track){
  const mh = track.motionHistory || [];
  const frameDiag = Math.hypot(overlay.width || 640, overlay.height || 480);
  if(mh.length < 4){
    return {
      dx: 0,
      dy: 0,
      direction: 'unknown',
      directionText: 'unclear',
      approachingCenter: false,
      leavingCenter: false,
      instability: 0,
      nervous: false
    };
  }

  const start = mh[Math.max(0, mh.length - 7)];
  const end = mh[mh.length - 1];
  const dx = (end[0] - start[0]) / frameDiag;
  const dy = (end[1] - start[1]) / frameDiag;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const minDirection = 0.012;
  let direction = 'unclear';
  let directionText = 'unclear';

  if(Math.max(absX, absY) >= minDirection){
    if(absX > absY * 1.35){
      direction = dx < 0 ? 'left' : 'right';
      directionText = dx < 0 ? 'LEFT' : 'RIGHT';
    }else if(absY > absX * 1.35){
      direction = dy < 0 ? 'up' : 'down';
      directionText = dy < 0 ? 'UP' : 'DOWN';
    }else{
      const vertical = dy < 0 ? 'UP' : 'DOWN';
      const horizontal = dx < 0 ? 'LEFT' : 'RIGHT';
      direction = `${dy < 0 ? 'up' : 'down'}_${dx < 0 ? 'left' : 'right'}`;
      directionText = `diagonal ${vertical}-${horizontal}`;
    }
  }

  let turns = 0;
  let samples = 0;
  let lastAngle = null;
  for(let i=Math.max(1, mh.length - 9); i<mh.length; i++){
    const a = mh[i - 1];
    const b = mh[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    if(Math.hypot(vx, vy) < frameDiag * 0.004) continue;
    const angle = Math.atan2(vy, vx);
    if(lastAngle !== null){
      let diff = Math.abs(angle - lastAngle);
      diff = Math.min(diff, Math.PI * 2 - diff);
      if(diff > 0.95) turns++;
    }
    lastAngle = angle;
    samples++;
  }
  const instability = samples > 1 ? Math.max(0, Math.min(1, turns / Math.max(1, samples - 1))) : 0;

  const centerX = (overlay.width || 640) / 2;
  const startDist = Math.abs(start[0] - centerX);
  const endDist = Math.abs(end[0] - centerX);
  return {
    dx,
    dy,
    direction,
    directionText,
    approachingCenter: startDist - endDist > (overlay.width || 640) * 0.05,
    leavingCenter: endDist - startDist > (overlay.width || 640) * 0.05,
    instability,
    nervous: instability >= 0.62
  };
}

function trackMotionState(speed, motionIntent){
  if(motionIntent && motionIntent.nervous){
    return { name: 'nervous', label: 'nervous', color: '#F15BB5' };
  }
  if(speed <= trackEvents.stopThreshold){
    return { name: 'still', label: 'still', color: '#B8C0CC' };
  }
  if(speed < trackEvents.moveThreshold){
    return { name: 'slow', label: 'slow', color: '#00E5FF' };
  }
  if(speed < trackEvents.moveThreshold * 2.8){
    return { name: 'normal', label: 'normal', color: '#7CFF6B' };
  }
  return { name: 'fast', label: 'fast / alert', color: '#FF4D4D' };
}

function zoneLabel(zone){
  if(zone === 'LINKS') return 'LEFT';
  if(zone === 'MITTE') return 'CENTER';
  if(zone === 'RECHTS') return 'RIGHT';
  return zone || 'UNKNOWN';
}

function trackBoxArea(track){
  const bbox = track.lastBBox || [0, 0, 0, 0];
  return Math.max(0, bbox[2] || 0) * Math.max(0, bbox[3] || 0);
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
        lastDirection: null,
        lastDirectionLoggedAt: 0,
        lastIntentLoggedAt: 0,
        observedObjectLogged: false,
        nervousLoggedAt: 0,
        lastMotionState: null,
        lastMotionStateLoggedAt: 0,
        maxBoxArea: 0,
        visibilityState: 'clear',
        visibilityLoggedAt: 0,
        predictedLogged: false,
        lastDwellMilestone: 0,
        escalation: 0,
        returnedLogged: false,
        intentLogged: false,
        loiterLogged: false,
        lastColor: null
      };
      trackEvents.states[t.id] = state;
      pushEvent(`${t.id} detected`);
    }

    if(trackEvents.missingFrames[t.id] > 0){
      pushEvent(`${t.id} returns after ${formatDuration(trackEvents.missingFrames[t.id] * 1000 / 30)} absence`);
      pushEvent(`${t.id} assignment after absence estimated`);
    }
    trackEvents.missingFrames[t.id] = 0;
    const speed = trackSpeedNorm(t);
    const motionIntent = trackMotionIntent(t);
    const motionState = trackMotionState(speed, motionIntent);
    const boxArea = trackBoxArea(t);
    if(t.time_since_update === 0 && boxArea > state.maxBoxArea * 0.65){
      state.maxBoxArea = Math.max(state.maxBoxArea, boxArea);
    }else if(state.maxBoxArea === 0){
      state.maxBoxArea = boxArea;
    }
    const visibilityRatio = state.maxBoxArea > 0 ? boxArea / state.maxBoxArea : 1;
    const predicted = t.time_since_update >= trackEvents.predictedFrames;
    const nowForVisibility = Date.now();
    if(predicted && !state.predictedLogged){
      state.predictedLogged = true;
      pushEvent(`${t.id} not directly visible, track is being continued`);
    }
    if(!predicted && state.predictedLogged){
      state.predictedLogged = false;
      pushEvent(`${t.id} clearly detected again`);
    }
    if(!predicted && visibilityRatio < 0.55 && state.visibilityState !== 'reduced' && nowForVisibility - state.visibilityLoggedAt >= trackEvents.visibilityLogMs){
      state.visibilityState = 'reduced';
      state.visibilityLoggedAt = nowForVisibility;
      pushEvent(`${t.id} visibility decreasing`);
      pushEvent(`${t.id} partially occluded`);
    }else if(!predicted && visibilityRatio > 0.75 && state.visibilityState === 'reduced' && nowForVisibility - state.visibilityLoggedAt >= trackEvents.visibilityLogMs){
      state.visibilityState = 'clear';
      state.visibilityLoggedAt = nowForVisibility;
      pushEvent(`${t.id} clearly detected again`);
    }
    const zone = trackZone(t);
    if(zone !== state.zone){
      state.zone = zone;
      state.zoneSince = Date.now();
      state.zoneDwellLogged = false;
      pushEvent(`${t.id} enters zone ${zoneLabel(zone)}`);
    }else if(state.zoneSince && !state.zoneDwellLogged && Date.now() - state.zoneSince >= trackEvents.zoneDwellMs){
      state.zoneDwellLogged = true;
      pushEvent(`${t.id} remains in zone ${zoneLabel(zone)} for ${formatDuration(Date.now() - state.zoneSince)}`);
      if(zone === 'MITTE'){
        pushEvent(`${t.id} exceeds observation time in zone CENTER`);
        if(!state.observedObjectLogged){
          state.observedObjectLogged = true;
          pushEvent(`${t.id} appears to observe the object`);
        }
      }
    }

    const observedMs = Date.now() - state.seenAt;
    const observedMilestones = [10, 30, 60, 120];
    for(const milestone of observedMilestones){
      if(observedMs >= milestone * 1000 && state.lastDwellMilestone < milestone){
        state.lastDwellMilestone = milestone;
        pushEvent(`${t.id} visible for ${formatDuration(observedMs)}`);
        break;
      }
    }

    const dwellScore = dwellScoreForState(state);
    const escalation = escalationForScore(dwellScore);
    if(escalation > state.escalation){
      state.escalation = escalation;
      const labels = ['registered', 'observed', 'flagged', 'critical'];
      pushEvent(`${t.id} Dwell Score level ${escalation}: ${labels[escalation - 1]}`);
    }

    if(motionState.name !== state.lastMotionState && Date.now() - state.lastMotionStateLoggedAt >= trackEvents.speedLogMs){
      state.lastMotionState = motionState.name;
      state.lastMotionStateLoggedAt = Date.now();
      if(motionState.name === 'fast'){
        pushEvent(`${t.id} speed flagged`);
      }else if(motionState.name === 'nervous' && zone !== 'MITTE'){
        pushEvent(`${t.id} movement pattern unstable`);
      }else if(motionState.name === 'slow'){
        pushEvent(`${t.id} movement slowing down`);
      }
    }

    if(speed >= trackEvents.moveThreshold){
      state.moveFrames++;
      state.stopFrames = 0;
      state.stillFrames = 0;
      if(speed < trackEvents.moveThreshold * 1.8){
        if(!state.slowSince) state.slowSince = Date.now();
        if(!state.slowLogged && Date.now() - state.slowSince >= trackEvents.slowMoveMs){
          state.slowLogged = true;
          pushEvent(`${t.id} moving slowly for ${formatDuration(Date.now() - state.slowSince)}`);
          pushEvent(`${t.id} movement intention unclear`);
        }
      }else{
        state.slowSince = null;
        state.slowLogged = false;
      }

      const now = Date.now();
      if(motionIntent.direction !== 'unknown' && motionIntent.direction !== 'unclear'){
        const directionChanged = motionIntent.direction !== state.lastDirection;
        const canLogDirection = now - state.lastDirectionLoggedAt >= trackEvents.directionLogMs;
        if(directionChanged || canLogDirection){
          state.lastDirection = motionIntent.direction;
          state.lastDirectionLoggedAt = now;
          pushEvent(`${t.id} moving ${motionIntent.directionText}`);
        }
      }

      if(motionIntent.approachingCenter && now - state.lastIntentLoggedAt >= trackEvents.directionLogMs){
        state.lastIntentLoggedAt = now;
        pushEvent(`${t.id} approaching zone CENTER`);
      }else if(motionIntent.leavingCenter && zone !== 'MITTE' && now - state.lastIntentLoggedAt >= trackEvents.directionLogMs){
        state.lastIntentLoggedAt = now;
        pushEvent(`${t.id} leaving zone CENTER`);
      }

      if(motionIntent.nervous && now - state.nervousLoggedAt >= trackEvents.nervousLogMs){
        state.nervousLoggedAt = now;
        pushEvent(`${t.id} movement pattern unstable`);
        if(zone === 'MITTE'){
          pushEvent(`${t.id} appears to observe the object`);
        }else{
          pushEvent(`${t.id} appears to scan the room`);
        }
      }

      if(!state.moving && state.moveFrames >= trackEvents.movementFrames){
        if(state.stillSince){
          pushEvent(`${t.id} moves again after ${formatDuration(Date.now() - state.stillSince)} stillness`);
          state.stillSince = null;
          state.lastStillMilestone = 0;
        }
        state.moving = true;
        state.loiterLogged = false;
        pushEvent(`${t.id} starts moving`);
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
        pushEvent(`${t.id} stops moving`);
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
            pushEvent(`${t.id} standing still for ${formatDuration(stillSeconds * 1000)}`);
            break;
          }
        }
      }
      if(!state.loiterLogged && state.stillFrames >= trackEvents.loiterFrames){
        state.loiterLogged = true;
        const dwell = state.stillSince ? ` (${formatDuration(Date.now() - state.stillSince)} stillness)` : '';
        pushEvent(`${t.id} loitering${dwell}`);
        pushEvent(`${t.id} trace is burning in`);
        if(zone === 'MITTE'){
          pushEvent(`${t.id} appears to observe the object`);
        }
      }
    }else{
      state.moveFrames = 0;
      state.stopFrames = 0;
      if(state.zone === 'MITTE' && state.stillSince && Date.now() - state.stillSince > 6000 && !state.intentLogged){
        state.intentLogged = true;
        pushEvent(`${t.id} movement intention unclear`);
        pushEvent(`${t.id} appears to observe the object`);
      }
    }

    const color = t.appearanceSummary && t.appearanceSummary.name;
    if(color && color !== 'Unknown' && color !== state.lastColor){
      state.lastColor = color;
      pushEvent(`${t.id} color feature: ${color}`);
    }
  }

  for(const id of Object.keys(trackEvents.states)){
    if(activeIds.has(id)) continue;
    trackEvents.missingFrames[id] = (trackEvents.missingFrames[id] || 0) + 1;
    if(trackEvents.missingFrames[id] === trackEvents.missingFramesLimit){
      const observed = trackEvents.states[id] && trackEvents.states[id].seenAt
        ? ` after ${formatDuration(Date.now() - trackEvents.states[id].seenAt)} observation`
        : '';
      pushEvent(`${id} leaves the field of view${observed}`);
      delete trackEvents.states[id];
      delete trackEvents.missingFrames[id];
    }
  }
}
