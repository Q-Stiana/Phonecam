/* Shared DOM references and mutable app state. */

// DOM elements
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusLabel = document.getElementById('status');
const facingSelect = document.getElementById('facingSelect');

let model = null; // loaded COCO-SSD model
const COCO_SSD_MODEL_URL = 'models/coco-ssd/model.json';
let stream = null; // MediaStream from getUserMedia
let running = false; // loop state
let facingMode = 'auto'; // 'auto', 'user' (front), or 'environment' (rear)
let selectedCameraId = ''; // exact camera deviceId when a physical camera is selected
let frameSkip = 2; // process detection every N frames (reduce CPU)
let frameCounter = 0;

// Proximity / Grouping state
const proximity = {
  threshold: 100, // pixels (default proximity distance)
  minGroupSize: 2,
  groups: {}, // current groups by id
  lastMembership: {}, // trackId -> groupId
  nextGroupId: 1
};

// stabilization / debounce
proximity.joinFrames = 3;
proximity.leaveFrames = 3;
proximity.counters = {}; // trackId -> consecutive frame count for pending change
proximity.stableMembership = {}; // confirmed membership after debounce


// Visual/UI mode state
let debugVisuals = false;
let noviceMode = false;
let narrationEnabled = false;
let heatmapEnabled = false;

// Heatmap state (initialized while rendering)
let heatmapGrid = null;
let heatmapW = 0;
let heatmapH = 0;
let heatmapCell = 16;
let heatmapDecay = 0.96;
