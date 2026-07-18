// ===================== State =====================
const STEP_LENGTH_M = 0.65; // average stride length in meters
const STORAGE_KEY = 'waypoint_walks';

let state = 'idle'; // idle | walking | paused
let watchId = null;
let timerId = null;

let positions = [];        // raw {lat, lng, accuracy, t} samples
let totalDistanceM = 0;    // meters
let elapsedMs = 0;         // accumulated walking time (excludes paused time)
let lastTickTime = null;   // timestamp of last updateTimer tick
let walkStartedAt = null;  // Date when walk started
let walkStartClock = null; // "HH:MM" start time string

// Canvas trail
let canvas, ctx;
let trailPoints = []; // projected {x, y} in meters relative to start, used for drawing

// ===================== DOM references =====================
const el = (id) => document.getElementById(id);

const statusPill = el('statusPill');
const statusLabel = el('statusLabel');
const gpsMessage = el('gpsMessage');

const statDistance = el('statDistance');
const statSteps = el('statSteps');
const statTime = el('statTime');
const statDate = el('statDate');

const btnStart = el('btnStart');
const btnPause = el('btnPause');
const btnResume = el('btnResume');
const btnStop = el('btnStop');

const livePanel = el('livePanel');
const liveTime = el('liveTime');
const liveDistance = el('liveDistance');
const liveSteps = el('liveSteps');
const liveAccuracy = el('liveAccuracy');

const walksList = el('walksList');
const emptyState = el('emptyState');
const historyCount = el('historyCount');

const saveModal = el('saveModal');
const sumDate = el('sumDate');
const sumDuration = el('sumDuration');
const sumDistance = el('sumDistance');
const sumSteps = el('sumSteps');
const walkNameInput = el('walkName');
const walkNotesInput = el('walkNotes');
const nameError = el('nameError');
const btnSaveWalk = el('btnSaveWalk');
const btnCancelSave = el('btnCancelSave');

// ===================== Init =====================
function init() {
  canvas = el('trailCanvas');
  ctx = canvas.getContext('2d');
  statDate.textContent = formatDateShort(new Date());
  drawTrailBackground();
  loadWalks();
  bindEvents();
}

function bindEvents() {
  btnStart.addEventListener('click', startWalk);
  btnPause.addEventListener('click', pauseWalk);
  btnResume.addEventListener('click', resumeWalk);
  btnStop.addEventListener('click', stopWalk);
  btnSaveWalk.addEventListener('click', saveWalk);
  btnCancelSave.addEventListener('click', closeSaveModal);
}

// ===================== Geolocation helpers =====================
function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function toRad(deg) { return (deg * Math.PI) / 180; }

// calculateDistance: adds distance between the last two recorded positions
function calculateDistance(prev, curr) {
  if (!prev) return 0;
  return haversineMeters(prev, curr);
}

// estimateSteps: Steps = distance (m) / average step length
function estimateSteps(distanceMeters) {
  return Math.round(distanceMeters / STEP_LENGTH_M);
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const point = { lat: latitude, lng: longitude, accuracy, t: Date.now() };

  if (positions.length > 0) {
    const prev = positions[positions.length - 1];
    const d = calculateDistance(prev, point);
    // ignore GPS jitter: skip implausible jumps under 1m or wildly large single-step jumps
    if (d > 1 && d < 200) {
      totalDistanceM += d;
    }
  }
  positions.push(point);
  updateTrailPoint(point);
  liveAccuracy.textContent = accuracy ? `± ${Math.round(accuracy)} m` : '— m';

  refreshLiveStats();
}

function onPositionError(err) {
  gpsMessage.textContent = `Location unavailable (${err.message}). Tracking paused until GPS reconnects.`;
}

function startGeoWatch() {
  if (!('geolocation' in navigator)) {
    gpsMessage.textContent = 'Geolocation is not supported on this device.';
    return;
  }
  gpsMessage.textContent = 'Requesting location permission…';
  watchId = navigator.geolocation.watchPosition(
    (pos) => { gpsMessage.textContent = ''; onPosition(pos); },
    onPositionError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function stopGeoWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// ===================== Timer =====================
function updateTimer() {
  const now = Date.now();
  if (lastTickTime !== null) {
    elapsedMs += now - lastTickTime;
  }
  lastTickTime = now;
  const timeStr = formatDuration(elapsedMs);
  statTime.textContent = timeStr;
  liveTime.textContent = timeStr;
}

function startTimerLoop() {
  lastTickTime = Date.now();
  timerId = setInterval(updateTimer, 1000);
}
function stopTimerLoop() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  lastTickTime = null;
}

// ===================== Walk lifecycle =====================
function startWalk() {
  state = 'walking';
  positions = [];
  trailPoints = [];
  totalDistanceM = 0;
  elapsedMs = 0;
  walkStartedAt = new Date();
  walkStartClock = formatClock(walkStartedAt);

  setStatus('walking', 'Walking');
  toggleButtons();
  livePanel.classList.remove('hidden');
  drawTrailBackground();

  startTimerLoop();
  startGeoWatch();
  refreshLiveStats();
}

function pauseWalk() {
  if (state !== 'walking') return;
  state = 'paused';
  stopTimerLoop();
  stopGeoWatch();
  setStatus('paused', 'Paused');
  toggleButtons();
}

function resumeWalk() {
  if (state !== 'paused') return;
  state = 'walking';
  setStatus('walking', 'Walking');
  toggleButtons();
  startTimerLoop();
  startGeoWatch();
}

function stopWalk() {
  if (state === 'idle') return;
  stopTimerLoop();
  stopGeoWatch();
  state = 'idle';
  setStatus('idle', 'Stopped');
  toggleButtons();
  livePanel.classList.add('hidden');
  openSaveModal();
}

function toggleButtons() {
  btnStart.classList.toggle('hidden', state !== 'idle');
  btnPause.classList.toggle('hidden', state !== 'walking');
  btnResume.classList.toggle('hidden', state !== 'paused');
  btnStop.classList.toggle('hidden', state === 'idle');
}

function setStatus(cls, label) {
  statusPill.classList.remove('status-idle', 'status-walking', 'status-paused');
  statusPill.classList.add(`status-${cls}`);
  statusLabel.textContent = label;
}

// ===================== Live stat rendering =====================
function refreshLiveStats() {
  const km = totalDistanceM / 1000;
  const steps = estimateSteps(totalDistanceM);

  statDistance.innerHTML = `${km.toFixed(2)}<small>km</small>`;
  statSteps.textContent = steps.toLocaleString();

  liveDistance.innerHTML = `${km.toFixed(2)} <small>km</small>`;
  liveSteps.textContent = steps.toLocaleString();
}

// ===================== Trail canvas (signature visual) =====================
function drawTrailBackground() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // faint contour rings, evokes a topo map
  ctx.strokeStyle = 'rgba(107,143,113,0.25)';
  ctx.lineWidth = 1;
  for (let r = 30; r < 500; r += 40) {
    ctx.beginPath();
    ctx.arc(w * 0.3, h * 0.65, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  redrawTrailPath();
}

function projectPoint(point, origin) {
  // equirectangular approximation, good enough for short walks
  const R = 6371000;
  const x = toRad(point.lng - origin.lng) * Math.cos(toRad(origin.lat)) * R;
  const y = toRad(point.lat - origin.lat) * R;
  return { x, y };
}

function updateTrailPoint(point) {
  if (positions.length === 1) {
    trailPoints = [{ x: 0, y: 0 }];
  } else {
    const origin = positions[0];
    trailPoints.push(projectPoint(point, origin));
  }
  redrawTrailPath();
}

function redrawTrailPath() {
  const w = canvas.width, h = canvas.height;
  // clear only trail layer by redrawing background rings + path each time
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(107,143,113,0.25)';
  ctx.lineWidth = 1;
  for (let r = 30; r < 500; r += 40) {
    ctx.beginPath();
    ctx.arc(w * 0.3, h * 0.65, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (trailPoints.length === 0) return;

  // fit points to canvas with padding
  const pad = 40;
  const xs = trailPoints.map(p => p.x), ys = trailPoints.map(p => p.y);
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 0);
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY, 40);

  const toCanvas = (p) => ({
    cx: w / 2 + (p.x - (minX + maxX) / 2) * scale,
    cy: h / 2 - (p.y - (minY + maxY) / 2) * scale
  });

  ctx.beginPath();
  ctx.strokeStyle = '#e8a33d';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  trailPoints.forEach((p, i) => {
    const { cx, cy } = toCanvas(p);
    if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
  });
  ctx.stroke();

  // start marker
  const startC = toCanvas(trailPoints[0]);
  ctx.beginPath();
  ctx.fillStyle = '#6b8f71';
  ctx.arc(startC.cx, startC.cy, 5, 0, Math.PI * 2);
  ctx.fill();

  // current marker
  const currC = toCanvas(trailPoints[trailPoints.length - 1]);
  ctx.beginPath();
  ctx.fillStyle = '#e8a33d';
  ctx.arc(currC.cx, currC.cy, 6, 0, Math.PI * 2);
  ctx.fill();
}

// ===================== Save modal =====================
function openSaveModal() {
  sumDate.textContent = formatDateShort(walkStartedAt || new Date());
  sumDuration.textContent = formatDuration(elapsedMs);
  sumDistance.textContent = `${(totalDistanceM / 1000).toFixed(2)} km`;
  sumSteps.textContent = estimateSteps(totalDistanceM).toLocaleString();
  walkNameInput.value = '';
  walkNotesInput.value = '';
  nameError.classList.add('hidden');
  saveModal.classList.remove('hidden');
  setTimeout(() => walkNameInput.focus(), 50);
}

function closeSaveModal() {
  saveModal.classList.add('hidden');
}

// ===================== Storage (CRUD) =====================
function getAllWalks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function persistWalks(walks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(walks));
}

function saveWalk() {
  const name = walkNameInput.value.trim();
  if (!name) {
    nameError.classList.remove('hidden');
    walkNameInput.focus();
    return;
  }

  const walks = getAllWalks();
  const walk = {
    id: Date.now(),
    name,
    notes: walkNotesInput.value.trim(),
    date: formatDateISO(walkStartedAt || new Date()),
    time: walkStartClock || formatClock(new Date()),
    duration: formatDuration(elapsedMs),
    distance: Number((totalDistanceM / 1000).toFixed(2)),
    steps: estimateSteps(totalDistanceM)
  };
  walks.unshift(walk);
  persistWalks(walks);
  closeSaveModal();
  renderWalks(walks);
}

function loadWalks() {
  const walks = getAllWalks();
  renderWalks(walks);
}

function deleteWalk(id) {
  const confirmed = confirm('Delete this walk?');
  if (!confirmed) return;
  const walks = getAllWalks().filter(w => w.id !== id);
  persistWalks(walks);
  renderWalks(walks);
}

function renderWalks(walks) {
  walksList.innerHTML = '';
  historyCount.textContent = `${walks.length} walk${walks.length === 1 ? '' : 's'} logged`;

  if (walks.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  walks.forEach(w => {
    const card = document.createElement('div');
    card.className = 'walk-card';
    card.innerHTML = `
      <div class="walk-card-main">
        <span class="walk-name">${escapeHtml(w.name)}</span>
        <span class="walk-meta">📅 ${formatDateDisplay(w.date)} · 🕒 ${w.time}</span>
        ${w.notes ? `<span class="walk-notes">${escapeHtml(w.notes)}</span>` : ''}
      </div>
      <div class="walk-card-stats">
        <div>${w.distance.toFixed(2)} km<span>distance</span></div>
        <div>${w.steps.toLocaleString()}<span>steps</span></div>
        <div>${w.duration}<span>duration</span></div>
      </div>
      <button class="btn-delete" data-id="${w.id}">🗑 Delete</button>
    `;
    card.querySelector('.btn-delete').addEventListener('click', () => deleteWalk(w.id));
    walksList.appendChild(card);
  });
}

// ===================== Formatting helpers =====================
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function formatClock(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatDateShort(d) {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatDateDisplay(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===================== Boot =====================
document.addEventListener('DOMContentLoaded', init);
