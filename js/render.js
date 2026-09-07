// Canvas rendering. Nothing here mutates game state.

import {
  TILE, T, SURFACE_ROW, WORLD_W, WORLD_H, PADS, PHYS, scanOf,
} from './config.js';
import { isOre, oreOf, idx } from './world.js';
import { SURFACE_Y, playerCenter } from './sim.js';

const ROCK_COLORS = {
  [T.DIRT]:      ['#6b4b2e', '#7a5735', '#5c4027'],
  [T.ROCK]:      ['#5a5a63', '#666670', '#4d4d56'],
  [T.DENSE]:     ['#454a58', '#4f5464', '#3b404c'],
  [T.OBSIDIAN]:  ['#2c2b3a', '#353347', '#232232'],
  [T.MAGMA]:     ['#40252a', '#4c2b30', '#341d22'],
  [T.CORESHELL]: ['#4a2f52', '#573860', '#3d2745'],
  [T.BEDROCK]:   ['#1a1a20', '#202026', '#141418'],
  [T.GAS]:       ['#4a5c3a', '#5a6f46', '#3d4d30'],
  [T.CORE]:      ['#c07dff', '#e0aaff', '#9d5bd6'],
};

const camera = { x: 0, y: 0, zoom: 1 };
let dark = null, darkCtx = null;

export function getCamera() { return camera; }

export function computeZoom(cssW, cssH) {
  const z = Math.min(cssW / (21 * TILE), cssH / (14 * TILE));
  return Math.max(0.62, Math.min(2.3, z));
}

function hash2(x, y) {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

export function render(ctx, state, cssW, cssH, dpr, alpha = 1) {
  const p = state.player;
  const c = playerCenter(p);
  camera.zoom = computeZoom(cssW, cssH);
  const viewW = cssW / camera.zoom, viewH = cssH / camera.zoom;

  let cx = c.x - viewW / 2;
  let cy = c.y - viewH / 2;
  cx = Math.max(0, Math.min(cx, WORLD_W * TILE - viewW));
  cy = Math.max(-viewH * 0.35, Math.min(cy, WORLD_H * TILE - viewH));

  if (state.shake > 0.05) {
    cx += (Math.random() - 0.5) * state.shake;
    cy += (Math.random() - 0.5) * state.shake;
  }
  // Snap the camera to whole device pixels: a fractional offset seams every
  // tile edge the moment the view moves.
  const px = camera.zoom * dpr;
  camera.x = Math.round(cx * px) / px;
  camera.y = Math.round(cy * px) / px;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSky(ctx, state, cssW, cssH);

  ctx.save();
  ctx.setTransform(px, 0, 0, px, -camera.x * px, -camera.y * px);
  drawWorld(ctx, state, viewW, viewH);
  drawPads(ctx, state);
  drawPlayer(ctx, state);
  drawFx(ctx, state);
  ctx.restore();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawDarkness(ctx, state, cssW, cssH, dpr);
  drawDepthGauge(ctx, state, cssW, cssH);
}

/* --------------------------------------------------------------- sky/base */

function drawSky(ctx, state, w, h) {
  const horizon = (SURFACE_Y - camera.y) * camera.zoom;
  const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
  g.addColorStop(0, '#12203a');
  g.addColorStop(0.55, '#2c3f63');
  g.addColorStop(1, '#7a5d55');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, Math.max(0, horizon));
  if (horizon < h) {
    ctx.fillStyle = '#0b0a10';
    ctx.fillRect(0, Math.max(0, horizon), w, h - Math.max(0, horizon));
  }

  // Stars fade out near the horizon; cheap parallax against the camera.
  if (horizon > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, horizon);
    ctx.clip();
    for (let i = 0; i < 70; i++) {
      const hx = hash2(i, 7) % 10000 / 10000;
      const hy = hash2(i, 13) % 10000 / 10000;
      const sx = (hx * w * 1.4 - camera.x * 0.12) % w;
      const sy = hy * horizon * 0.85;
      const tw = 0.45 + 0.55 * Math.sin(state.time * 1.7 + i);
      ctx.globalAlpha = 0.5 * tw * (1 - sy / Math.max(1, horizon));
      ctx.fillStyle = '#dfe9ff';
      ctx.fillRect(sx < 0 ? sx + w : sx, sy, 1.6, 1.6);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ world */

function drawWorld(ctx, state, viewW, viewH) {
  const world = state.world;
  const x0 = Math.max(0, Math.floor(camera.x / TILE) - 1);
  const x1 = Math.min(WORLD_W - 1, Math.ceil((camera.x + viewW) / TILE) + 1);
  const y0 = Math.max(0, Math.floor(camera.y / TILE) - 1);
  const y1 = Math.min(WORLD_H - 1, Math.ceil((camera.y + viewH) / TILE) + 1);
  const OV = 1;                                   // 1px overlap hides seams

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = world.tiles[idx(x, y)];
      const wx = x * TILE, wy = y * TILE;
      if (!world.seen[idx(x, y)]) {
        ctx.fillStyle = '#0c0b12';
        ctx.fillRect(wx, wy, TILE + OV, TILE + OV);
        ctx.fillStyle = 'rgba(255,255,255,0.022)';
        ctx.fillRect(wx + (hash2(x, y) >> 4) % 20, wy + (hash2(x, y) >> 11) % 20, 7, 5);
        continue;
      }
      if (t === T.EMPTY) {
        if (y >= SURFACE_ROW) {
          ctx.fillStyle = '#131018';
          ctx.fillRect(wx, wy, TILE + OV, TILE + OV);
        }
        continue;
      }
      if (t === T.LAVA) { drawLava(ctx, state, wx, wy); continue; }
      drawRock(ctx, x, y, t, wx, wy, OV);
      if (isOre(t)) drawOre(ctx, state, oreOf(t), wx, wy, x, y);
      if (t === T.GAS) drawGas(ctx, state, wx, wy);
      if (t === T.CORE) drawCore(ctx, state, wx, wy);
    }
  }

  // Crack overlay on whatever the drill is chewing on.
  const d = state.dig;
  if (d.x >= 0 && d.progress > 0) {
    const wx = d.x * TILE, wy = d.y * TILE;
    ctx.save();
    ctx.globalAlpha = Math.min(1, d.progress);
    ctx.strokeStyle = 'rgba(255,225,180,0.85)';
    ctx.lineWidth = 1.6;
    const steps = 3 + Math.floor(d.progress * 5);
    for (let i = 0; i < steps; i++) {
      const h = hash2(d.x * 31 + i, d.y * 17 + i);
      const ax = wx + (h % TILE), ay = wy + ((h >> 8) % TILE);
      ctx.beginPath();
      ctx.moveTo(wx + TILE / 2, wy + TILE / 2);
      ctx.lineTo(ax, ay);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawRock(ctx, x, y, t, wx, wy, OV) {
  const pal = ROCK_COLORS[t] || ROCK_COLORS[T.ROCK];
  const h = hash2(x, y);
  ctx.fillStyle = pal[h % 3];
  ctx.fillRect(wx, wy, TILE + OV, TILE + OV);

  // Two speckles per tile give the rock a grain without a texture atlas.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(wx + (h >> 3) % (TILE - 6), wy + (h >> 9) % (TILE - 6), 5, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(wx + (h >> 14) % (TILE - 5), wy + (h >> 19) % (TILE - 5), 4, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(wx, wy + TILE - 2, TILE + OV, 2);
}

function drawOre(ctx, state, ore, wx, wy, x, y) {
  const h = hash2(x + 5, y + 11);
  const cx = wx + TILE / 2 + ((h % 7) - 3) * 0.7;
  const cy = wy + TILE / 2 + (((h >> 5) % 7) - 3) * 0.7;
  const r = 6 + (h % 3);
  const pulse = 0.55 + 0.45 * Math.sin(state.time * 2 + (h % 100));

  ctx.save();
  ctx.globalAlpha = 0.30 * pulse;
  ctx.fillStyle = ore.glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = ore.color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.85, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.85, cy);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = ore.glow;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.4, cy - r * 0.15);
  ctx.lineTo(cx, cy + r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawLava(ctx, state, wx, wy) {
  const wob = Math.sin(state.time * 2.4 + wx * 0.05) * 0.5 + 0.5;
  const g = ctx.createLinearGradient(0, wy, 0, wy + TILE);
  g.addColorStop(0, `rgb(${210 + wob * 40},${70 + wob * 40},20)`);
  g.addColorStop(1, '#7a1e08');
  ctx.fillStyle = g;
  ctx.fillRect(wx, wy, TILE + 1, TILE + 1);
  ctx.fillStyle = `rgba(255,200,90,${0.25 + wob * 0.3})`;
  ctx.fillRect(wx, wy + 2 + wob * 2, TILE + 1, 3);
}

function drawGas(ctx, state, wx, wy) {
  const pulse = 0.4 + 0.6 * Math.abs(Math.sin(state.time * 3 + wx));
  ctx.save();
  ctx.globalAlpha = 0.5 * pulse;
  ctx.fillStyle = '#b6ff7a';
  ctx.beginPath();
  ctx.arc(wx + TILE / 2, wy + TILE / 2, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1d2a14';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('!', wx + TILE / 2, wy + TILE / 2 + 5);
  ctx.textAlign = 'left';
}

function drawCore(ctx, state, wx, wy) {
  const pulse = 0.5 + 0.5 * Math.sin(state.time * 4);
  ctx.save();
  ctx.globalAlpha = 0.5 + 0.4 * pulse;
  ctx.fillStyle = '#f0d0ff';
  ctx.beginPath();
  ctx.arc(wx + TILE / 2, wy + TILE / 2, 12 + pulse * 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------- base */

function drawPads(ctx, state) {
  for (const pad of PADS) {
    const x = pad.x * TILE, y = SURFACE_Y;
    const near = state.nearPad && state.nearPad.key === pad.key;

    // A hut with an open front, so a rig parked on the pad still reads.
    ctx.fillStyle = '#191b23';
    ctx.fillRect(x - 14, y - 52, TILE + 28, 52);
    ctx.fillStyle = '#252833';
    ctx.fillRect(x - 14, y - 52, TILE + 28, 12);
    ctx.fillStyle = pad.color;
    ctx.fillRect(x - 14, y - 52, TILE + 28, 4);
    ctx.fillStyle = near ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.045)';
    ctx.fillRect(x - 8, y - 36, TILE + 16, 36);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 3, y - 30, TILE + 6, 30);
    ctx.fillStyle = pad.color;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(x - 3, y - 4, TILE + 6, 4);
    ctx.globalAlpha = 1;

    ctx.fillStyle = pad.color;
    ctx.globalAlpha = near ? 1 : 0.55;
    ctx.beginPath();
    ctx.arc(x + TILE / 2, y - 58, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = near ? '#fff' : 'rgba(255,255,255,0.55)';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(pad.name.toUpperCase(), x + TILE / 2, y - 64);
    if (near) ctx.fillText('[ E ]', x + TILE / 2, y - 76);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#3a3020';
  ctx.fillRect(0, SURFACE_Y - 3, WORLD_W * TILE, 3);
}

/* ----------------------------------------------------------------- player */

function drawPlayer(ctx, state) {
  const p = state.player;
  const w = PHYS.playerW, h = PHYS.playerH;

  if (p.thrusting) {
    const f = 8 + Math.random() * 10;
    const g = ctx.createLinearGradient(0, p.y + h, 0, p.y + h + f);
    g.addColorStop(0, 'rgba(255,220,120,0.95)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(p.x + 4, p.y + h, w - 8, f);
  }

  ctx.fillStyle = '#2b2f3a';
  ctx.fillRect(p.x - 2, p.y + 4, w + 4, h - 8);
  ctx.fillStyle = '#e0a33c';
  ctx.fillRect(p.x, p.y, w, h - 4);
  ctx.fillStyle = '#c07f22';
  ctx.fillRect(p.x, p.y + h - 10, w, 6);

  ctx.fillStyle = '#8fd8ff';
  ctx.fillRect(p.x + (p.facing > 0 ? 10 : 4), p.y + 4, 10, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(p.x + (p.facing > 0 ? 10 : 4), p.y + 4, 10, 3);

  // Drill bit: three teeth spun by an angle the sim advances in seconds.
  const dx = p.x + w / 2, dy = p.y + h;
  ctx.save();
  ctx.translate(dx, dy);
  ctx.rotate(p.drillSpin);
  ctx.fillStyle = '#cfd6e0';
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(7, 2);
    ctx.lineTo(0, 9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = '#7d8698';
  ctx.beginPath();
  ctx.arc(dx, dy, 3.4, 0, Math.PI * 2);
  ctx.fill();

  if (state.stranded) {
    ctx.fillStyle = 'rgba(255,90,90,' + (0.4 + 0.6 * Math.abs(Math.sin(state.time * 6))) + ')';
    ctx.fillRect(p.x + w / 2 - 1.5, p.y - 9, 3, 5);
  }
}

function drawFx(ctx, state) {
  for (const f of state.fx) {
    const t = (f.until - state.time) / Math.max(0.001, f.until - f.born);
    ctx.globalAlpha = Math.max(0, Math.min(1, t));
    if (f.text) {
      ctx.fillStyle = f.color;
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y);
      ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = f.color;
      ctx.fillRect(f.x - f.r / 2, f.y - f.r / 2, f.r, f.r);
    }
  }
  ctx.globalAlpha = 1;
}

/* --------------------------------------------------------------- overlays */

function drawDarkness(ctx, state, w, h, dpr) {
  const depth = state.depth;
  // Deep is dark, but never so dark that the shaft stops being readable.
  const gloom = Math.max(0, Math.min(0.62, (depth - 22) / 120));
  if (gloom <= 0.01) return;

  const dw = Math.max(1, Math.round(w * dpr)), dh = Math.max(1, Math.round(h * dpr));
  if (!dark || dark.width !== dw || dark.height !== dh) {
    dark = document.createElement('canvas');
    dark.width = dw; dark.height = dh;
    darkCtx = dark.getContext('2d');
  }
  darkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  darkCtx.clearRect(0, 0, w, h);
  darkCtx.fillStyle = `rgba(2,2,6,${gloom})`;
  darkCtx.fillRect(0, 0, w, h);

  const c = playerCenter(state.player);
  const sx = (c.x - camera.x) * camera.zoom;
  const sy = (c.y - camera.y) * camera.zoom;
  const lamp = (scanOf(state.upgrades) * 0.55 + 5.0) * TILE * camera.zoom;
  const g = darkCtx.createRadialGradient(sx, sy, lamp * 0.15, sx, sy, lamp);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.88)');
  g.addColorStop(0.82, 'rgba(0,0,0,0.45)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  darkCtx.globalCompositeOperation = 'destination-out';
  darkCtx.fillStyle = g;
  darkCtx.fillRect(sx - lamp, sy - lamp, lamp * 2, lamp * 2);
  darkCtx.globalCompositeOperation = 'source-over';

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(dark, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawDepthGauge(ctx, state, w, h) {
  const x = w - 16, top = h * 0.18, bottom = h * 0.82;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x - 4, top - 8, 8, bottom - top + 16);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  for (let d = 0; d <= 250; d += 50) {
    const y = top + (bottom - top) * (d / 255);
    ctx.fillRect(x - 8, y, 16, 1);
  }
  const my = top + (bottom - top) * Math.min(1, state.stats.deepest / 255);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(x - 7, my, 14, 1.5);

  const py = top + (bottom - top) * Math.min(1, state.depth / 255);
  ctx.fillStyle = '#e0a33c';
  ctx.beginPath();
  ctx.moveTo(x - 7, py); ctx.lineTo(x + 7, py - 4); ctx.lineTo(x + 7, py + 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
