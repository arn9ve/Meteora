/**
 * Phone attitude + compass (+ optional depth proxies) for Safari / Chromium.
 *
 * Slot phones (all LiDAR-capable hardware): 1 = iPhone 12 Pro Max, 2 = iPhone 13 Pro Max,
 * 3 = iPhone 15 Pro. Hardware LiDAR does **not** reach Safari like ARKit — no ARKit depth
 * stream in this web app. AbsoluteOrientationSensor is Chromium-only. iPhone Safari uses
 * DeviceOrientation + webkitCompassHeading (after a user gesture). WebXR immersive-ar /
 * depth is probed but usually unavailable on iPhone Safari; focusDistance is a rare proxy.
 * True LiDAR mapping needs a native/AR companion (or a future WebXR depth session).
 */

const LENS_FOV = { wide: 100, normal: 68, tele: 32 };
const PERSON_HEIGHT_M = 1.7;

/** @typedef {{
 *   headingDeg: number | null,
 *   headingSource: 'absolute-orientation' | 'webkit-compass' | 'deviceorientation' | null,
 *   alpha: number | null,
 *   beta: number | null,
 *   gamma: number | null,
 *   tiltDeg: number | null,
 *   rollDeg: number | null,
 *   absolute: boolean,
 *   depthM: number | null,
 *   depthSource: 'webxr' | 'focus' | null,
 *   webxrSupported: boolean | null,
 *   permission: 'unknown' | 'granted' | 'denied' | 'prompt' | 'unsupported',
 *   at: number,
 * }} SensorSnapshot */

/** @type {SensorSnapshot} */
let latest = emptySensors();
/** @type {(() => void) | null} */
let stopListening = null;
/** @type {number | null} */
let depthTimer = 0;
/** @type {MediaStreamTrack | null} */
let videoTrack = null;

function emptySensors() {
  return {
    headingDeg: null,
    headingSource: null,
    alpha: null,
    beta: null,
    gamma: null,
    tiltDeg: null,
    rollDeg: null,
    absolute: false,
    depthM: null,
    depthSource: null,
    webxrSupported: null,
    permission: 'unknown',
    at: 0,
  };
}

function norm360(deg) {
  const n = deg % 360;
  return n < 0 ? n + 360 : n;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Pitch-down tilt from DeviceOrientation beta/gamma (portrait-ish phones). */
function tiltFromOrientation(beta, gamma) {
  if (!Number.isFinite(beta)) return null;
  // beta ≈ 0 flat face-up, 90 upright; looking down toward floor increases beta past 90 or uses gamma in landscape.
  // Mount tilt-down from level: 0 = looking level (beta≈90), 90 = straight down (beta≈180 / screen parallel to floor face-down-ish).
  const upright = Math.abs(beta);
  // Convert "screen facing direction" into "camera looking down from horizon".
  // When phone is upright (beta≈90), tilt≈0; laid face-down (beta≈0) is awkward; tipped forward (beta→180) = looking down.
  if (upright <= 90) {
    // Tipped backward / face-up-ish: treat as looking slightly up (negative) or near level.
    return round1(Math.max(-30, Math.min(90, 90 - upright)));
  }
  return round1(Math.max(-30, Math.min(90, upright - 90)));
}

/**
 * @param {number} alpha
 * @param {number} beta
 * @param {number} gamma
 * @param {number | null | undefined} webkitHeading
 * @param {boolean} absolute
 */
function applyDeviceOrientation(alpha, beta, gamma, webkitHeading, absolute) {
  latest.alpha = Number.isFinite(alpha) ? round1(alpha) : null;
  latest.beta = Number.isFinite(beta) ? round1(beta) : null;
  latest.gamma = Number.isFinite(gamma) ? round1(gamma) : null;
  latest.tiltDeg = tiltFromOrientation(beta, gamma);
  latest.rollDeg = Number.isFinite(gamma) ? round1(gamma) : null;
  latest.absolute = Boolean(absolute) || Number.isFinite(webkitHeading);
  latest.at = Date.now();

  if (Number.isFinite(webkitHeading)) {
    latest.headingDeg = round1(norm360(webkitHeading));
    latest.headingSource = 'webkit-compass';
  } else if (absolute && Number.isFinite(alpha)) {
    // Absolute DeviceOrientation: alpha is compass-ish (implementation-dependent).
    latest.headingDeg = round1(norm360(360 - alpha));
    latest.headingSource = 'deviceorientation';
  } else if (Number.isFinite(alpha) && latest.headingSource !== 'webkit-compass') {
    latest.headingDeg = round1(norm360(360 - alpha));
    latest.headingSource = latest.headingSource ?? 'deviceorientation';
  }
}

function startAbsoluteOrientation() {
  const SensorCtor = globalThis.AbsoluteOrientationSensor;
  if (typeof SensorCtor !== 'function') return null;
  try {
    const sensor = new SensorCtor({ frequency: 8, referenceFrame: 'device' });
    sensor.addEventListener('reading', () => {
      const [x, y, z, w] = sensor.quaternion ?? [];
      if (![x, y, z, w].every(Number.isFinite)) return;
      // Yaw from quaternion (ENU-ish); good enough as a Chromium heading hint.
      const siny = 2 * (w * z + x * y);
      const cosy = 1 - 2 * (y * y + z * z);
      const yaw = (Math.atan2(siny, cosy) * 180) / Math.PI;
      latest.headingDeg = round1(norm360(-yaw));
      latest.headingSource = 'absolute-orientation';
      latest.absolute = true;
      // Pitch (tilt down): from quaternion
      const sinp = 2 * (w * y - z * x);
      const pitch = (Math.asin(Math.max(-1, Math.min(1, sinp))) * 180) / Math.PI;
      latest.tiltDeg = round1(Math.max(-30, Math.min(90, -pitch)));
      latest.at = Date.now();
    });
    sensor.addEventListener('error', () => {
      try {
        sensor.stop();
      } catch {
        /* ignore */
      }
    });
    sensor.start();
    return () => {
      try {
        sensor.stop();
      } catch {
        /* ignore */
      }
    };
  } catch {
    return null;
  }
}

function startDeviceOrientation() {
  const handler = (event) => {
    applyDeviceOrientation(
      event.alpha,
      event.beta,
      event.gamma,
      event.webkitCompassHeading,
      Boolean(event.absolute),
    );
  };
  window.addEventListener('deviceorientationabsolute', handler);
  window.addEventListener('deviceorientation', handler);
  return () => {
    window.removeEventListener('deviceorientationabsolute', handler);
    window.removeEventListener('deviceorientation', handler);
  };
}

async function probeWebXr() {
  try {
    if (!navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') {
      latest.webxrSupported = false;
      return;
    }
    latest.webxrSupported = await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    latest.webxrSupported = false;
  }
}

function readFocusDistance() {
  try {
    const settings = videoTrack?.getSettings?.() ?? {};
    if (typeof settings.focusDistance === 'number' && settings.focusDistance > 0) {
      latest.depthM = Math.min(20, Math.max(0.2, settings.focusDistance));
      latest.depthSource = 'focus';
      return;
    }
  } catch {
    /* ignore */
  }
  // No Safari LiDAR / focus distance → clear proxy unless something else set it.
  if (latest.depthSource === 'focus') {
    latest.depthM = null;
    latest.depthSource = null;
  }
}

/**
 * Request iOS motion permission (needs a tap) and start listeners.
 * @returns {Promise<SensorSnapshot>}
 */
export async function enableSensors() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const state = await DeviceOrientationEvent.requestPermission();
      latest.permission = state === 'granted' ? 'granted' : 'denied';
      if (state !== 'granted') return getSensors();
    } catch {
      latest.permission = 'denied';
      return getSensors();
    }
  } else if (typeof DeviceOrientationEvent === 'undefined' && typeof AbsoluteOrientationSensor !== 'function') {
    latest.permission = 'unsupported';
    return getSensors();
  } else {
    latest.permission = 'granted';
  }

  if (stopListening) stopListening();
  const stops = [];
  const absStop = startAbsoluteOrientation();
  if (absStop) stops.push(absStop);
  stops.push(startDeviceOrientation());
  stopListening = () => {
    for (const stop of stops) stop();
    stopListening = null;
  };

  void probeWebXr();
  if (depthTimer) window.clearInterval(depthTimer);
  depthTimer = window.setInterval(readFocusDistance, 2000);
  readFocusDistance();
  latest.at = Date.now();
  return getSensors();
}

/** @param {MediaStreamTrack | null} track */
export function setVideoTrack(track) {
  videoTrack = track;
  readFocusDistance();
}

export function getSensors() {
  return { ...latest };
}

export function sensorsReady() {
  return latest.permission === 'granted' && (latest.headingDeg != null || latest.tiltDeg != null);
}

/**
 * Horizontal yaw offset (degrees) of a normalized box centre from the optical axis.
 * Positive = to the person's right in the picture = clockwise from phone heading in room math.
 */
export function yawOffsetDeg(box, lens = 'normal', aspect = 9 / 16) {
  const hfov = ((LENS_FOV[lens] ?? LENS_FOV.normal) * Math.PI) / 180;
  const u = box.x + box.w / 2;
  return round1((-Math.atan((u - 0.5) * 2 * Math.tan(hfov / 2)) * 180) / Math.PI);
}

/** Distance estimate: depth proxy if any, else bbox height of a ~1.7 m person. */
export function estimateDistanceM(box, lens = 'normal', aspect = 9 / 16) {
  if (typeof latest.depthM === 'number' && latest.depthM > 0) {
    return { distanceM: latest.depthM, distanceSource: latest.depthSource || 'focus' };
  }
  const hfov = ((LENS_FOV[lens] ?? LENS_FOV.normal) * Math.PI) / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) * aspect);
  if (!(box.h > 0.02)) return { distanceM: null, distanceSource: null };
  const clipped = box.y + box.h > 0.98 || box.y < 0.02;
  let distance = PERSON_HEIGHT_M / (box.h * 2 * Math.tan(vfov / 2));
  if (clipped) distance *= 0.8;
  distance = Math.min(15, Math.max(0.5, distance));
  return { distanceM: round1(distance), distanceSource: 'bbox' };
}

/**
 * Person-in-room relative estimate (compass + bbox; depth when available).
 * Room integration uses yawOffsetDeg with the plan phone heading (magnetic ≠ plan north).
 */
export function estimatePerson(box, lens = 'normal', aspect = 9 / 16) {
  const yaw = yawOffsetDeg(box, lens, aspect);
  const { distanceM, distanceSource } = estimateDistanceM(box, lens, aspect);
  const heading = latest.headingDeg;
  return {
    yawOffsetDeg: yaw,
    distanceM,
    distanceSource,
    compassBearingDeg:
      heading != null && Number.isFinite(yaw) ? round1(norm360(heading + yaw)) : null,
    tiltDeg: latest.tiltDeg,
    depthM: latest.depthM,
    sensorsAt: latest.at || null,
  };
}

export function formatSensorsLine(s = latest) {
  if (s.permission === 'denied') return 'Motion denied — tap Enable sensors';
  if (s.permission === 'unsupported') return 'No orientation API in this browser';
  if (s.permission !== 'granted') return 'Tap Enable sensors (compass + tilt)';
  const bits = [];
  if (s.headingDeg != null) bits.push(`compass ${s.headingDeg.toFixed(0)}° (${s.headingSource || '?'})`);
  else bits.push('compass —');
  if (s.tiltDeg != null) bits.push(`tilt↓ ${s.tiltDeg.toFixed(0)}°`);
  if (s.rollDeg != null) bits.push(`roll ${s.rollDeg.toFixed(0)}°`);
  if (s.depthM != null) bits.push(`depth~ ${s.depthM.toFixed(1)} m (${s.depthSource})`);
  else bits.push(s.webxrSupported ? 'depth: WebXR AR possible, no depth yet' : 'depth: none (Safari ≠ LiDAR)');
  return bits.join(' · ');
}
