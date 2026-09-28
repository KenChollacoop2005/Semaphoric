import { MIRROR } from './capture.js';
import { cellLuminance } from './filter-cpu.js';

const MEDIAPIPE_VERSION = '1.0.1';
const MEDIAPIPE_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';
const AUTO_INPUT_WIDTH = 256;
const AUTO_PERSON_THRESHOLD = 0.5;

// Auto background (MediaPipe)
export class AutoBackground {
  constructor() {
    this.ready = false;
    this.loading = null;
    this.delegate = '';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cellConf = new Float32Array(0);
    this.loggedMasks = false;
  }

  load() {
    if (!this.loading) this.loading = this.init();
    return this.loading;
  }

  async init() {
    const { FilesetResolver, ImageSegmenter } = await import(`${MEDIAPIPE_BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    try {
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('MediaPipe GPU delegate failed, using CPU', err);
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
    this.ready = true;
  }

  classify(video, cols, rows, outFg) {
    const w = AUTO_INPUT_WIDTH;
    const h = Math.round(w * video.videoHeight / video.videoWidth);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (MIRROR) this.ctx.setTransform(-1, 0, 0, 1, w, 0);
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    if (this.cellConf.length !== cols * rows) this.cellConf = new Float32Array(cols * rows);

    this.segmenter.segmentForVideo(this.canvas, performance.now(), (result) => {
      const masks = result.confidenceMasks;
      if (!this.loggedMasks) {
        console.info(`MediaPipe confidence masks: ${masks.length}`);
        this.loggedMasks = true;
      }
      const mask = masks[masks.length - 1];
      cellLuminance(mask.getAsFloat32Array(), mask.width, mask.height, cols, rows, this.cellConf);
    });

    for (let i = 0; i < outFg.length; i++) {
      outFg[i] = this.cellConf[i] >= AUTO_PERSON_THRESHOLD ? 1 : 0;
    }
  }
}
