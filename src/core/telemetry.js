// Lightweight, queryable-later usage signal - not a dashboard, not a
// server call, no third-party script. Exists to answer three questions
// once there's enough real usage to ask them:
//
//   1. Is Style used by people who never touch Materials/Colourways in the
//      same session, or mostly by existing studio users having fun with it?
//   2. When Style was active, do people export a GLB/PNG (a studio
//      deliverable) or a WebM clip (a social deliverable)?
//   3. Does entry point/referrer correlate with a session ever touching
//      Style?
//
// Stored as a flat, timestamped event log in localStorage - deliberately
// not pre-aggregated into those three answers, so any other question this
// data could answer later is still askable from the raw log, not just the
// ones anticipated today. Capped so it can never grow unbounded on a
// machine that never clears storage.

const STORAGE_KEY = '3dmviewer.telemetry';
const SESSION_KEY = '3dmviewer.telemetry.session';
const MAX_EVENTS = 500;

const sessionId = (() => {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // Private browsing or blocked storage - events still log, just without
    // a stable session id to group them by.
    return 'unknown';
  }
})();

function readLog() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function writeLog(events) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Quota exceeded or storage blocked - this is signal, not a feature;
    // the app behaves identically either way.
  }
}

/** Append one event. Keep names/data small and stable - this is the schema. */
export function logEvent(name, data = {}) {
  const events = readLog();
  events.push({ session: sessionId, name, data, t: Date.now() });
  writeLog(events);
}

/** Read the full raw log back out, for whenever "queryable later" happens. */
export function readTelemetry() {
  return readLog();
}

let materialsTouched = false;
let styleTouched = false;

/** Call once, at startup. */
export function logSessionStart() {
  logEvent('session_start', { referrer: document.referrer || null, url: location.href });
}

/**
 * Call from the one place material state actually changes
 * (viewer.js's afterMaterialChange()) - covers manual edits, resets, and
 * colourway apply in a single chokepoint, so no individual control needs
 * to remember to call this itself.
 */
export function markMaterialsTouched() {
  if (materialsTouched) return;
  materialsTouched = true;
  logEvent('materials_touched');
}

/** Call from the Style panel's first real control use this session. */
export function markStyleTouched() {
  if (styleTouched) return;
  styleTouched = true;
  logEvent('style_touched');
}

/**
 * Call on every export action that produces a downloadable file.
 * @param {'glb'|'png'|'webm'} type
 */
export function logExport(type) {
  logEvent('export', { type, styleActive: styleTouched });
}
