const CAMERA_WIDTH = 1280;
const CAMERA_HEIGHT = 720;
const REFERENCE_WIDTH = 1280;
const SAMPLES_X = 2;
const SAMPLES_Y = 4;
const SMOOTHING_QUALITY = 'medium';
export const MIRROR = true;
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export async function startCapture(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
    audio: false,
  });
  await resetAutoExposure(stream.getVideoTracks()[0]);
  video.srcObject = stream;
  await video.play();

  // Reference space for cell size, camera aspect
  const width = REFERENCE_WIDTH;
  const height = Math.round(REFERENCE_WIDTH * video.videoHeight / video.videoWidth);

  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let luma = new Float32Array(0);
  let sampleWidth = 0;
  let sampleHeight = 0;

  // Sample canvas sized to grid, not camera
  function setGrid(cols, rows) {
    sampleWidth = cols * SAMPLES_X;
    sampleHeight = rows * SAMPLES_Y;
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = SMOOTHING_QUALITY;
    if (MIRROR) ctx.setTransform(-1, 0, 0, 1, sampleWidth, 0);
    luma = new Float32Array(sampleWidth * sampleHeight);
  }

  // Draw current frame, return luminance 0..1
  function grab() {
    ctx.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    const px = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
      luma[i] = (LUMA_R * px[j] + LUMA_G * px[j + 1] + LUMA_B * px[j + 2]) / 255;
    }
    return luma;
  }

  return {
    stream, video, width, height, setGrid, grab,
    track: stream.getVideoTracks()[0],
    get sampleWidth() { return sampleWidth; },
    get sampleHeight() { return sampleHeight; },
  };
}

const AUTO_MODES = ['exposureMode', 'whiteBalanceMode', 'focusMode'];

// Undo any manual mode a driver kept from earlier
async function resetAutoExposure(track) {
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const before = track.getSettings();
  const constraint = {};
  for (const mode of AUTO_MODES) {
    if (caps[mode] && caps[mode].includes('continuous')) constraint[mode] = 'continuous';
  }
  if (Object.keys(constraint).length) {
    try {
      await track.applyConstraints({ advanced: [constraint] });
    } catch (err) {
      console.warn('auto exposure reset failed', err);
    }
  }
  const after = track.getSettings();
  console.info('camera auto modes', Object.fromEntries(
    AUTO_MODES.map((m) => [m, `${before[m] ?? 'n/a'} -> ${after[m] ?? 'n/a'}`]),
  ));
}
