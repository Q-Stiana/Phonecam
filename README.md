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
