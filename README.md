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
`people` list. Each visible person contains only:

```text
id, timestamp, x, y, w, h, color, dwell
```

`x`, `y`, `w`, and `h` are normalized bounding-box values. `dwell` is seconds
since the person was first observed. Adjust the send rate with the
`TD send interval (ms)` slider in the browser.

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
