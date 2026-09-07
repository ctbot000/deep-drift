// Wiring: canvas, input, the fixed-timestep loop, saving, and screen overlays.

import {
  createGame, newInput, step, serialize, deserialize,
} from './sim.js';
import { render } from './render.js';
import { updateHud, togglePanel, closePanel, isPanelOpen, useItemKey, tryRescue } from './ui.js';
import { ensureAudio, sfx, setThrust, setEnabled, isEnabled } from './audio.js';

const SAVE_KEY = 'deepdrift.save.v1';
const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.25;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const $ = (id) => document.getElementById(id);

let state = null;
let input = newInput();
let paused = false;
let started = false;
let last = 0, acc = 0;
let dpr = 1, cssW = 0, cssH = 0;

/* ------------------------------------------------------------------ setup */

function resize() {
  dpr = Math.min(2.5, window.devicePixelRatio || 1);
  // A collapsed or not-yet-laid-out surface measures 0x0, and every derived
  // value (zoom, camera, viewport) is nonsense from there. Floor it.
  cssW = Math.max(320, canvas.clientWidth || window.innerWidth || 960);
  cssH = Math.max(240, canvas.clientHeight || window.innerHeight || 600);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}
window.addEventListener('resize', resize);

/* ------------------------------------------------------------ persistence */

// localStorage can throw or silently do nothing (private windows, blocked site
// data). Keep an in-memory mirror so a failed write never produces a stale read.
let memorySave = null;

function save() {
  // The title screen runs a placeholder world behind the card. Saving that
  // would offer a first-time visitor "Continue" for a game they never started.
  if (!state || !started) return;
  const data = serialize(state);
  memorySave = data;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (_) { /* the mirror above is the fallback */ }
}

function loadSave() {
  if (memorySave) return memorySave;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearSave() {
  memorySave = null;
  try { localStorage.removeItem(SAVE_KEY); } catch (_) { /* nothing to do */ }
}

/* ------------------------------------------------------------------- loop */

function frame(now) {
  requestAnimationFrame(frame);
  // The timestamp baseline and the accumulator are one piece of state: reset
  // them together, or the first frame after a pause carries the whole gap.
  if (!last) { last = now; acc = 0; }
  let dt = (now - last) / 1000;
  last = now;
  if (dt < 0) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

  // Parked at a shop: the world keeps ticking, the rig does not.
  if (isPanelOpen()) { input.left = input.right = input.up = input.down = false; }

  if (!paused && state && state.status === 'playing') {
    acc += dt;
    let guard = 0;
    while (acc >= FIXED_DT && guard++ < 240) {
      step(state, FIXED_DT, input);
      acc -= FIXED_DT;
    }
    drainEvents(dt);
  } else {
    acc = 0;
  }

  if (state) {
    render(ctx, state, cssW, cssH, dpr);
    updateHud(state);
    if (state.status === 'won' && $('win').classList.contains('hidden')) showWin();
  }
}

let sinceSave = 0;
function drainEvents(dt) {
  // One frame can hold many fixed steps; collapse repeats so a 120Hz drill
  // does not fire 120 sounds a second.
  const kinds = new Set(state.events);
  state.events.length = 0;
  for (const e of kinds) sfx(e);
  if (kinds.has('wreck')) save();
  setThrust(state.player.thrusting && state.status === 'playing');

  sinceSave += dt;
  if (sinceSave > 6) { sinceSave = 0; save(); }
}

/* ------------------------------------------------------------------ input */

const KEYS = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', Space: 'up',
  ArrowDown: 'down', KeyS: 'down',
};

window.addEventListener('keydown', (e) => {
  ensureAudio();
  if (e.repeat) return;

  if (KEYS[e.code] !== undefined) {
    if (!isPanelOpen()) input[KEYS[e.code]] = true;
    e.preventDefault();
    return;
  }
  switch (e.code) {
    case 'KeyE':
      if (state) togglePanel(state);
      e.preventDefault();
      break;
    case 'Escape':
      if (isPanelOpen()) closePanel();
      else if ($('help').classList.contains('hidden')) togglePause();
      else $('help').classList.add('hidden');
      break;
    case 'KeyH': toggleHelp(); break;
    case 'KeyM': setEnabled(!isEnabled()); updateMuteButton(); break;
    case 'KeyR': if (state) tryRescue(state); break;
    case 'Digit1': if (state) useItemKey(state, 'teleport'); break;
    case 'Digit2': if (state) useItemKey(state, 'repair'); break;
    case 'Digit3': if (state) useItemKey(state, 'fuelcell'); break;
    default: break;
  }
});

window.addEventListener('keyup', (e) => {
  if (KEYS[e.code] !== undefined) { input[KEYS[e.code]] = false; e.preventDefault(); }
});

window.addEventListener('blur', () => { input = newInput(); setThrust(false); });

// A hidden tab delivers no frames; drop the stale baseline on the way back in.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { input = newInput(); setThrust(false); save(); }
  else { last = 0; acc = 0; }
});

/* --------------------------------------------------------- touch controls */

function bindTouch() {
  const map = [['t-left', 'left'], ['t-right', 'right'], ['t-up', 'up'], ['t-down', 'down']];
  for (const [id, key] of map) {
    const el = $(id);
    const on = (e) => { ensureAudio(); input[key] = true; e.preventDefault(); };
    const off = (e) => { input[key] = false; e.preventDefault(); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
  }
  $('t-act').addEventListener('pointerdown', (e) => {
    ensureAudio();
    if (state) { if (state.stranded && !state.nearPad) tryRescue(state); else togglePanel(state); }
    e.preventDefault();
  });
  if (window.matchMedia('(pointer: coarse)').matches) {
    document.body.classList.add('touch');
  }
}

/* --------------------------------------------------------------- overlays */

function togglePause() {
  if (!started || !state || state.status !== 'playing') return;
  paused = !paused;
  $('paused').classList.toggle('hidden', !paused);
  if (!paused) { last = 0; acc = 0; }
  else { save(); setThrust(false); }
}

function toggleHelp() {
  const h = $('help');
  h.classList.toggle('hidden');
}

function updateMuteButton() {
  $('mute').textContent = isEnabled() ? '🔊' : '🔇';
}

function showWin() {
  const s = state.stats;
  const mins = Math.floor(s.playTime / 60), secs = Math.round(s.playTime % 60);
  $('win-stats').innerHTML = `
    <li><span>Time in the hole</span><b>${mins}m ${secs}s</b></li>
    <li><span>Ore hauled up</span><b>${s.mined.toLocaleString()} loads</b></li>
    <li><span>Total earned</span><b>$${Math.round(s.earned).toLocaleString()}</b></li>
    <li><span>Cash on hand</span><b>$${Math.round(state.money).toLocaleString()}</b></li>
    <li><span>Rigs destroyed</span><b>${s.wrecks}</b></li>
    <li><span>Deepest point</span><b>${Math.round(s.deepest)} m</b></li>`;
  $('win').classList.remove('hidden');
  save();
}

/* ------------------------------------------------------------------ start */

function startGame(loaded) {
  state = loaded || createGame();
  input = newInput();
  started = true;
  paused = false;
  last = 0; acc = 0;
  closePanel();
  $('title').classList.add('hidden');
  $('win').classList.add('hidden');
  $('paused').classList.add('hidden');
  resize();
  save();
}

function boot() {
  resize();
  bindTouch();
  updateMuteButton();

  const existing = loadSave();
  const cont = $('continue');
  if (existing) {
    cont.classList.remove('hidden');
    cont.querySelector('.sub').textContent =
      `$${Math.round(existing.money).toLocaleString()} · deepest ${Math.round(existing.stats?.deepest || 0)} m`;
  }

  cont.addEventListener('click', () => {
    ensureAudio();
    const s = deserialize(loadSave());
    startGame(s);
  });
  $('new-game').addEventListener('click', () => {
    ensureAudio();
    clearSave();
    startGame(null);
  });
  $('how-to').addEventListener('click', toggleHelp);
  $('help-close').addEventListener('click', toggleHelp);
  $('panel-close').addEventListener('click', closePanel);
  $('mute').addEventListener('click', () => { ensureAudio(); setEnabled(!isEnabled()); updateMuteButton(); });
  $('pause-btn').addEventListener('click', togglePause);
  $('resume').addEventListener('click', togglePause);
  $('win-again').addEventListener('click', () => { clearSave(); startGame(null); });
  window.addEventListener('beforeunload', save);

  // Something has to be on screen behind the title card, but it must not move.
  state = createGame(1234);
  paused = true;
  requestAnimationFrame(frame);
}

boot();
