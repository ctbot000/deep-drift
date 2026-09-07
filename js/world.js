// World generation. Deterministic for a given seed; DOM-free.

import {
  T, WORLD_W, WORLD_H, SURFACE_ROW, ORES, bandTile, ROCK_HARDNESS,
} from './config.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const idx = (x, y) => y * WORLD_W + x;
export const depthOf = (y) => y - SURFACE_ROW;

export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H;
}

export function tileAt(world, x, y) {
  if (x < 0 || x >= WORLD_W) return T.BEDROCK;
  if (y < 0) return T.EMPTY;
  if (y >= WORLD_H) return T.BEDROCK;
  return world.tiles[idx(x, y)];
}

export function isOre(t) { return t >= T.ORE; }
export function oreOf(t) { return isOre(t) ? ORES[t - T.ORE] : null; }

// Solid = blocks movement. Lava does not; you fall straight into it.
export function isSolid(t) {
  return t !== T.EMPTY && t !== T.LAVA;
}

export function isDiggable(t) {
  return t !== T.EMPTY && t !== T.BEDROCK && t !== T.LAVA;
}

export function hardnessAt(world, x, y) {
  const t = tileAt(world, x, y);
  if (t === T.BEDROCK || t === T.EMPTY || t === T.LAVA) return Infinity;
  if (isOre(t)) return ROCK_HARDNESS[bandTile(depthOf(y))] ?? 1;
  return ROCK_HARDNESS[t] ?? 1;
}

// Triangular falloff around an ore's peak depth.
function oreWeight(ore, d) {
  if (d < ore.min || d > ore.max) return 0;
  const spread = Math.max(ore.peak - ore.min, ore.max - ore.peak, 1);
  return Math.max(0, 1 - Math.abs(d - ore.peak) / spread);
}

export function generateWorld(seed = 1) {
  const rnd = mulberry32(seed);
  const tiles = new Uint8Array(WORLD_W * WORLD_H);
  const seen = new Uint8Array(WORLD_W * WORLD_H);

  // 1. Sky above, banded rock below.
  for (let y = 0; y < WORLD_H; y++) {
    const d = depthOf(y);
    for (let x = 0; x < WORLD_W; x++) {
      tiles[idx(x, y)] = y < SURFACE_ROW ? T.EMPTY : bandTile(d);
    }
  }

  // 2. Indestructible shell: side walls and the floor of the world.
  for (let y = 0; y < WORLD_H; y++) {
    tiles[idx(0, y)] = y < SURFACE_ROW ? T.EMPTY : T.BEDROCK;
    tiles[idx(WORLD_W - 1, y)] = y < SURFACE_ROW ? T.EMPTY : T.BEDROCK;
  }
  for (let x = 0; x < WORLD_W; x++) tiles[idx(x, WORLD_H - 1)] = T.BEDROCK;

  // 3. Caves. Elliptical blobs, never in the first few metres so the surface
  //    stays walkable and the first shaft is always solid rock.
  const blobs = [];
  const blobCount = 150;
  for (let i = 0; i < blobCount; i++) {
    const cy = SURFACE_ROW + 14 + Math.floor(rnd() * (WORLD_DEPTH_SAFE() - 16));
    const cx = 2 + Math.floor(rnd() * (WORLD_W - 4));
    const rx = 1.6 + rnd() * 3.8;
    const ry = 1.2 + rnd() * 2.6;
    blobs.push({ cx, cy, rx, ry });
    carveEllipse(tiles, cx, cy, rx, ry, T.EMPTY);
  }

  // 4. Lava pools in the deep bands: the bottom slice of a deep cave fills up.
  for (const b of blobs) {
    if (depthOf(b.cy) < 150) continue;
    if (rnd() > 0.42) continue;
    const floor = Math.round(b.cy + b.ry);
    const top = Math.max(Math.round(b.cy), floor - 2);
    for (let y = top; y <= floor; y++) {
      for (let x = Math.round(b.cx - b.rx); x <= Math.round(b.cx + b.rx); x++) {
        if (!inBounds(x, y) || x === 0 || x === WORLD_W - 1) continue;
        if (tiles[idx(x, y)] === T.EMPTY) tiles[idx(x, y)] = T.LAVA;
      }
    }
  }

  // 5. Gas pockets, embedded in solid rock, from mid depth down.
  for (let y = SURFACE_ROW + 45; y < WORLD_H - 2; y++) {
    for (let x = 1; x < WORLD_W - 1; x++) {
      const t = tiles[idx(x, y)];
      if (t === T.EMPTY || t === T.LAVA || t === T.BEDROCK) continue;
      if (rnd() < 0.0045) tiles[idx(x, y)] = T.GAS;
    }
  }

  // 6. Ore veins.
  const chances = new Float64Array(ORES.length);
  for (let y = SURFACE_ROW; y < WORLD_H - 1; y++) {
    const d = depthOf(y);
    for (let x = 1; x < WORLD_W - 1; x++) {
      const t = tiles[idx(x, y)];
      if (t === T.EMPTY || t === T.LAVA || t === T.BEDROCK || t === T.GAS) continue;
      if (t >= T.ORE) continue;
      // One roll across every ore eligible at this depth, so the cheap ores
      // near the top of the list do not claim cells the deep ones wanted.
      let total = 0;
      for (let o = 0; o < ORES.length; o++) {
        const w = oreWeight(ORES[o], d);
        chances[o] = w > 0 ? ORES[o].freq * w : 0;
        total += chances[o];
      }
      if (total <= 0) continue;
      let r = rnd();
      if (r >= total) continue;
      for (let o = 0; o < ORES.length; o++) {
        r -= chances[o];
        if (r < 0) { placeVein(tiles, rnd, x, y, T.ORE + o); break; }
      }
    }
  }

  // 7. The Core: the run's finish line, buried at the bottom centre. Big
  //    enough to hit once you know roughly where it is.
  const coreX = Math.floor(WORLD_W / 2);
  const coreY = WORLD_H - 5;
  for (let y = coreY - 4; y <= coreY + 3; y++) {
    for (let x = coreX - 5; x <= coreX + 5; x++) {
      if (!inBounds(x, y) || x <= 0 || x >= WORLD_W - 1) continue;
      if (tiles[idx(x, y)] === T.BEDROCK) continue;
      tiles[idx(x, y)] = T.CORESHELL;
    }
  }
  for (let y = coreY - 1; y <= coreY + 1; y++) {
    for (let x = coreX - 1; x <= coreX + 1; x++) tiles[idx(x, y)] = T.CORE;
  }

  const world = { w: WORLD_W, h: WORLD_H, tiles, seen, coreX, coreY, seed };
  revealSurface(world);
  return world;
}

function WORLD_DEPTH_SAFE() { return WORLD_H - SURFACE_ROW - 8; }

function carveEllipse(tiles, cx, cy, rx, ry, fill) {
  const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
  const y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inBounds(x, y) || x <= 0 || x >= WORLD_W - 1) continue;
      if (y < SURFACE_ROW + 10 || y >= WORLD_H - 1) continue;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) tiles[idx(x, y)] = fill;
    }
  }
}

function placeVein(tiles, rnd, x, y, tile) {
  tiles[idx(x, y)] = tile;
  const extra = Math.floor(rnd() * 4);
  let cx = x, cy = y;
  for (let i = 0; i < extra; i++) {
    cx += Math.floor(rnd() * 3) - 1;
    cy += Math.floor(rnd() * 3) - 1;
    if (!inBounds(cx, cy) || cx <= 0 || cx >= WORLD_W - 1 || cy < SURFACE_ROW) return;
    const t = tiles[idx(cx, cy)];
    if (t === T.EMPTY || t === T.LAVA || t === T.BEDROCK || t >= T.ORE) return;
    tiles[idx(cx, cy)] = tile;
  }
}

// The surface strip is always known; everything below starts unseen.
export function revealSurface(world) {
  for (let y = 0; y <= SURFACE_ROW + 1; y++) {
    for (let x = 0; x < WORLD_W; x++) world.seen[idx(x, y)] = 1;
  }
}

export function reveal(world, cx, cy, radius) {
  const r = Math.ceil(radius);
  const r2 = radius * radius;
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= WORLD_H) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= WORLD_W) continue;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) world.seen[idx(x, y)] = 1;
    }
  }
}

// Rough census used by the balance harness.
export function oreCensus(world) {
  const counts = ORES.map(() => 0);
  for (let i = 0; i < world.tiles.length; i++) {
    const t = world.tiles[i];
    if (t >= T.ORE) counts[t - T.ORE]++;
  }
  return counts;
}
