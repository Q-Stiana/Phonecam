# Phonecam
Ausstellung Bell - Areal

## Offline setup

This sketch is prepared for an installation laptop without internet access.
TensorFlow.js, COCO-SSD, and the model weights are stored locally in `vendor/`
and `models/coco-ssd/`.

Start it through a local web server from this folder:

```sh
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

Do not open `index.html` directly by double-clicking it. The camera and model
loading are more reliable through `localhost`.

## TouchDesigner local WebSocket

The browser sends lean tracking data to the local relay:

```text
ws://127.0.0.1:8001
```

Each tracking frame contains `timestamp`, `count`, `width`, `height`, and a
`people` list. `x`, `y`, `w`, and `h` are normalized bounding-box values.
`dwell` is seconds since the person was first observed. Adjust the send rate
with the `TD send interval (ms)` slider in the browser.

```text
id, timestamp, x, y, w, h, color, dwell
```

### Data available for TouchDesigner

The sketch already sends the following values for every active ID/person in the
`tracking` message. These values are meant to be easy to connect to visuals in
TouchDesigner.

Basic ID and position:

```text
id       ID label, for example ID1
x, y     normalized position from 0.0 to 1.0
px, py   position in pixels
bbox     bounding box: x, y, w, h
```

Fixed TouchDesigner function per ID:

Each ID also receives one fixed TouchDesigner function. This makes it easy to
connect different IDs to different visuals.

```text
tdFunctionSlot    number from 1 to 10
tdFunctionName    machine-readable function name
tdFunctionLabel   readable description
tdFunctionValue   control value from 0.0 to 1.0
tdFunctionActive  true/false trigger
```

ID mapping:

```text
ID1   red_filter             red filter from clothing color
ID2   burn_in_trace          loitering burn-in trace
ID3   dwell_escalation       dwell score / escalation
ID4   motion_speed           motion speed distortion
ID5   nervous_glitch         nervous movement glitch
ID6   direction_flow         directional flow field
ID7   center_approach        approaching center trigger
ID8   proximity_lines        group / proximity lines
ID9   tracking_uncertainty   predicted / occluded ghosting
ID10  zone_mask              zone-based mask or filter
```

In TouchDesigner, `tdFunctionValue` can usually drive the effect intensity, and
`tdFunctionActive` can be used as an on/off trigger.

Color / clothing:

```text
color            dominant color category, for example Red, Blue, Black, White
colorConfidence  confidence of the color reading, 0.0 to 1.0
colorRgb         RGB value of the dominant color
redScore         how much red is detected, 0.0 to 1.0
redActive        true when red is above the threshold
```

Visual ideas:

```text
redScore   -> fade in a red filter
redActive  -> switch a red effect on/off
colorRgb   -> tint particles, lines, or feedback trails
```

Dwell time / loitering:

```text
observedMs, observedSeconds  how long the ID is visible
stillMs, stillSeconds        how long the ID is standing still
dwellScore                   dwell intensity, 0.0 to 1.0
escalation                   surveillance level, 0 to 4
burnIn                       trace/burn-in intensity, 0.0 to 1.0
burnInActive                 true when burn-in should become visible
```

Visual ideas:

```text
dwellScore    -> make an effect stronger over time
burnIn        -> draw a persistent trace
burnInActive  -> start a burned-in trail or imprint
escalation    -> switch between calm, alert, critical visual states
```

Zones:

```text
zone  LINKS, MITTE, RECHTS, or UNKNOWN
```

Visual ideas:

```text
LINKS / MITTE / RECHTS -> trigger different visual areas or filters
MITTE                  -> react when someone observes the central object/image
```

Motion:

```text
speed             raw movement amount
moving            true/false
motionState       still, slow, normal, fast, nervous
motionStateLabel  readable label
motionColor       category color as hex value
```

Visual ideas:

```text
still    -> freeze, hold, or imprint the image
slow     -> draw soft traces
normal   -> normal line movement
fast     -> red distortion or alarm-like movement
nervous  -> glitch, flicker, unstable feedback
```

Direction and intent:

```text
direction          left, right, up, down, diagonal..., unclear
directionText      readable text, for example "nach LINKS"
directionX         horizontal movement direction/value
directionY         vertical movement direction/value
approachingCenter  true when the ID moves toward the center
leavingCenter      true when the ID moves away from the center
instability        unstable/nervous movement, 0.0 to 1.0
nervous            true/false
```

Visual ideas:

```text
directionX/Y       -> move particles, smears, or feedback in that direction
approachingCenter  -> intensify the image when someone approaches the center
instability        -> control glitch amount
nervous            -> switch on unstable visual treatment
```

Proximity / group behavior:

```text
groupId      group label, for example G1, or null
inGroup      true/false
interaction  none, unclear_motion, loitering, close_proximity
```

Visual ideas:

```text
close_proximity -> draw lines or fields between people
loitering       -> burn a trace into the projection
unclear_motion  -> make the visual ambiguous or unstable
```

Tracking uncertainty:

```text
predicted         true when the ID is not directly visible and is being continued
visibilityRatio   estimated visibility, 0.0 to 1.0
visibilityState   clear or reduced
```

Visual ideas:

```text
predicted = true          -> ghost trail, flicker, fading silhouette
visibilityState=reduced   -> make the ID/image fragment or become transparent
visibilityRatio           -> control opacity or noise amount
```

Event log messages:

The browser also sends `event` messages with a Zurich timestamp:

```text
type
timestamp
timeZurich
text
```

Example event texts:

```text
ID1 erfasst
ID1 steht still seit 10s
ID2 Geschwindigkeit auffällig
ID2 Bewegungsmuster nervös / instabil
ID3 Zuordnung nach Abwesenheit geschätzt
ID2 nicht direkt sichtbar, Spur wird fortgeführt
ID1 Spur brennt sich ein
```

Good first values to test in TouchDesigner:

```text
redScore
redActive
dwellScore
burnIn
burnInActive
motionState
motionColor
directionX
directionY
instability
predicted
visibilityState
zone
interaction
```

## TouchDesigner WebSocket bridge

TouchDesigner does not need to host the WebSocket server. Run the local relay:

```sh
python websocket_bridge.py
```

Then connect both clients to:

```text
ws://127.0.0.1:8001
```

The browser sends tracking JSON to the relay, and the relay forwards it to
TouchDesigner. In TouchDesigner, set the WebSocket DAT to client/connect mode.
Use `touch_designer.py` as the WebSocket DAT callback script. Create Table DATs
named `phonecam_people`, `phonecam_info`, and `phonecam_id1_color` to receive
broken-out rows.

`phonecam_id1_color` exposes only the current color for `ID1`:

```text
present, color, r, g, b, hue, saturation, value, dwell, timestamp
```

Use the `r`, `g`, and `b` rows as color parameters, or use `hue`, `saturation`,
and `value` for HSV-style filtering.

The bridge prints connection and occasional relay summaries only. Change the
summary cadence with:

```sh
python websocket_bridge.py --log-every 2
```

Use `--log-every 0` to disable message summaries.

## JavaScript layout

- `app.js` handles camera/model lifecycle, the detection loop, controls, and tooltips.
- `js/state.js` stores shared DOM references and mutable app state.
- `js/websocket.js` sends tracking data to the local WebSocket relay.
- `js/utils.js` contains math, geometry, color, and canvas helpers.
- `js/appearance.js` extracts color/appearance histograms from video crops.
- `js/tracker.js` contains the tracker and assignment logic.
- `js/events.js` manages the event log and movement/loitering events.
- `js/render.js` draws the canvas overlay, groups, debug visuals, and heatmap.
