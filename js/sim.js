// Game state and the fixed-step simulation. DOM-free on purpose: tools/balance.mjs
// drives this exact code headlessly.

import {
  TILE, T, SURFACE_ROW, WORLD_W, ORES, UPGRADES, ITEMS, PADS, PHYS, FUEL, PRICES, START_MONEY, drillOf, maxFuel, maxHull, maxCargo, engineOf, scanOf,
} from './config.js';
import {
  generateWorld, tileAt, isSolid, isDiggable, isOre, oreOf, hardnessAt, reveal, idx,
} from './world.js';

export const SURFACE_Y = SURFACE_ROW * TILE;      // ground line in world pixels
const SALVAGE_RATE = 0.35;                       // of cargo value, returned after a wreck
// Spawn between two pads so the rig is never hidden behind a building.
const SPAWN_X = Math.round((PADS[0].x + PADS[1].x) / 2) * TILE;

export function newInput() {
  return { left: false, right: false, up: false, down: false };
}

export function createGame(seed = (Math.random() * 1e9) | 0) {
  const world = generateWorld(seed);
  const state = {
    seed,
    world,
    time: 0,                     // accumulated simulated seconds — the only clock
    status: 'playing',           // playing | won
    money: START_MONEY,
    upgrades: { drill: 0, fuel: 0, hull: 0, cargo: 0, engine: 0, scanner: 0 },
    items: { teleport: 0, repair: 0, fuelcell: 0 },
    cargo: ORES.map(() => 0),
    cargoCount: 0,
    player: {
      x: SPAWN_X, y: SURFACE_Y - PHYS.playerH,
      vx: 0, vy: 0, onGround: true, facing: 1,
      fuel: 100, hull: 100, drillSpin: 0, thrusting: false, drilling: false,
    },
    dig: { x: -1, y: -1, progress: 0 },
    depth: 0,
    nearPad: null,
    coreKnown: false,
    stranded: false,
    shake: 0,
    fx: [],                      // particles, all with sim-time deadlines
    toasts: [],
    stats: { earned: 0, spent: 0, mined: 0, wrecks: 0, deepest: 0, trips: 0, playTime: 0 },
    events: [],
  };
  state.player.fuel = maxFuel(state.upgrades);
  state.player.hull = maxHull(state.upgrades);
  reveal(world, Math.floor(SPAWN_X / TILE), SURFACE_ROW, scanOf(state.upgrades));
  return state;
}

/* ---------------------------------------------------------------- helpers */

export function cargoValue(state) {
  let v = 0;
  for (let i = 0; i < ORES.length; i++) v += state.cargo[i] * ORES[i].value;
  return v;
}

export function emit(state, name) {
  state.events.push(name);
  if (state.events.length > 32) state.events.shift();
}

export function toast(state, text, kind = 'info') {
  state.toasts.push({ text, kind, until: state.time + 3.2 });
  if (state.toasts.length > 6) state.toasts.shift();
}

function spark(state, x, y, color, count = 6, speed = 90, life = 0.5) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.35 + Math.random() * 0.9);
    state.fx.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30,
      r: 1.4 + Math.random() * 2.2, color,
      until: state.time + life * (0.6 + Math.random() * 0.8), born: state.time,
    });
  }
  if (state.fx.length > 420) state.fx.splice(0, state.fx.length - 420);
}

function floater(state, x, y, text, color) {
  state.fx.push({ x, y, text, color, vx: 0, vy: -34, until: state.time + 1.3, born: state.time });
}

export function playerCenter(p) {
  return { x: p.x + PHYS.playerW / 2, y: p.y + PHYS.playerH / 2 };
}

function solidAtPx(world, px, py) {
  return isSolid(tileAt(world, Math.floor(px / TILE), Math.floor(py / TILE)));
}

/* ------------------------------------------------------------- collisions */

function collideAxis(state, dx, dy) {
  const p = state.player;
  const w = PHYS.playerW, h = PHYS.playerH;
  p.x += dx; p.y += dy;

  const x0 = Math.floor(p.x / TILE), x1 = Math.floor((p.x + w - 1) / TILE);
  const y0 = Math.floor(p.y / TILE), y1 = Math.floor((p.y + h - 1) / TILE);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!isSolid(tileAt(state.world, tx, ty))) continue;
      if (dx > 0) { p.x = tx * TILE - w; p.vx = 0; }
      else if (dx < 0) { p.x = (tx + 1) * TILE; p.vx = 0; }
      else if (dy > 0) {
        p.y = ty * TILE - h;
        landed(state, p.vy);
        p.vy = 0; p.onGround = true;
      } else if (dy < 0) { p.y = (ty + 1) * TILE; p.vy = 0; }
      return;
    }
  }
}

function landed(state, vy) {
  if (vy <= PHYS.fallDamageSpeed) return;
  const dmg = (vy - PHYS.fallDamageSpeed) * PHYS.fallDamageScale;
  if (dmg < 1) return;
  damage(state, dmg, 'the landing');
  emit(state, 'hurt');
  state.shake = Math.max(state.shake, Math.min(9, dmg * 0.35));
  const c = playerCenter(state.player);
  spark(state, c.x, state.player.y + PHYS.playerH, '#8b7355', 10, 130, 0.45);
}

export function damage(state, amount, cause) {
  const p = state.player;
  if (p.hull <= 0) return;
  p.hull -= amount;
  if (p.hull > 0) return;
  p.hull = 0;
  wreck(state, cause);
}

function wreck(state, cause) {
  const p = state.player;
  state.stats.wrecks++;
  emit(state, 'wreck');
  // The salvage crew recovers part of the load. Losing a deep haul outright
  // erases half an hour of play, which is a worse punishment than the game
  // needs.
  const lost = cargoValue(state);
  const salvage = Math.round(lost * SALVAGE_RATE);
  for (let i = 0; i < state.cargo.length; i++) state.cargo[i] = 0;
  state.cargoCount = 0;
  state.money += salvage;
  state.stats.earned += salvage;
  toSurface(state);
  p.hull = maxHull(state.upgrades) * 0.4;
  p.fuel = Math.max(p.fuel, maxFuel(state.upgrades) * 0.3);
  state.stranded = false;
  toast(state, `Rig destroyed by ${cause}. The salvage crew recovered $${salvage.toLocaleString()} of a $${lost.toLocaleString()} load.`, 'bad');
}

function toSurface(state) {
  const p = state.player;
  p.x = SPAWN_X; p.y = SURFACE_Y - PHYS.playerH;
  p.vx = 0; p.vy = 0; p.onGround = true;
  state.dig.x = -1; state.dig.progress = 0;
  state.stats.trips++;
}

/* ------------------------------------------------------------- the update */

export function step(state, dt, input) {
  if (state.status !== 'playing') return;
  dt = Math.min(Math.max(dt, 0), 0.05);          // clamp both ends; never negative
  state.time += dt;
  state.stats.playTime += dt;

  const p = state.player;
  const up = state.upgrades;
  const eng = engineOf(up);
  const fuelMax = maxFuel(up);
  const dead = p.fuel <= 0;

  // ------- horizontal
  const accel = PHYS.moveAccel * eng;
  const vmax = PHYS.moveMax * eng;
  let moving = false;
  if (!dead && input.left && !input.right) { p.vx -= accel * dt; p.facing = -1; moving = true; }
  else if (!dead && input.right && !input.left) { p.vx += accel * dt; p.facing = 1; moving = true; }
  else {
    const f = (p.onGround ? PHYS.groundFriction : PHYS.airFriction) * dt;
    if (Math.abs(p.vx) <= f) p.vx = 0; else p.vx -= Math.sign(p.vx) * f;
  }
  p.vx = Math.max(-vmax, Math.min(vmax, p.vx));

  // ------- vertical
  p.thrusting = false;
  if (!dead && input.up) {
    p.vy -= PHYS.thrust * eng * dt;
    p.thrusting = true;
    if (p.vy < -PHYS.maxThrustUp * eng) p.vy = -PHYS.maxThrustUp * eng;
  }
  p.vy += PHYS.gravity * dt;
  if (p.vy > PHYS.maxFall) p.vy = PHYS.maxFall;

  p.onGround = false;
  collideAxis(state, p.vx * dt, 0);
  collideAxis(state, 0, p.vy * dt);

  // Stay inside the world box.
  p.x = Math.max(TILE, Math.min(p.x, (WORLD_W - 1) * TILE - PHYS.playerW));
  if (p.y < 0) { p.y = 0; p.vy = Math.max(0, p.vy); }

  // ------- digging
  p.drilling = false;
  let dir = null;
  if (input.down) dir = [0, 1];
  else if (input.left && !input.right) dir = [-1, 0];
  else if (input.right && !input.left) dir = [1, 0];

  if (dir && !dead) tryDig(state, dir, dt);
  else { state.dig.x = -1; state.dig.progress = 0; }

  // ------- fuel
  let burn = FUEL.idle;
  if (moving) burn += FUEL.move;
  if (p.thrusting) burn += FUEL.thrust;
  if (p.drilling) burn += FUEL.drill;
  if (onSurface(state)) burn = 0;                 // idling at base is free
  p.fuel = Math.max(0, p.fuel - burn * dt);
  if (p.fuel <= 0 && !state.stranded) {
    state.stranded = true;
    toast(state, 'Out of fuel. Use a Fuel Cell, or call for rescue.', 'bad');
  } else if (p.fuel > 0 && state.stranded) state.stranded = false;

  // ------- hazards
  hazards(state, dt);

  // ------- bookkeeping
  const c = playerCenter(p);
  state.depth = Math.max(0, (c.y - SURFACE_Y) / TILE);
  if (!state.coreKnown && state.depth >= 185) {
    state.coreKnown = true;
    reveal(state.world, state.world.coreX, state.world.coreY, 6);
    const dx = state.world.coreX - Math.floor(c.x / TILE);
    const dir = dx === 0 ? 'directly below' : `${Math.abs(dx)} m ${dx < 0 ? 'west' : 'east'}`;
    toast(state, `Your instruments pick up the hum. The anomaly is at the centre of the field — ${dir} of you, near the bottom.`, 'good');
  }
  state.stats.deepest = Math.max(state.stats.deepest, state.depth);
  reveal(state.world, Math.floor(c.x / TILE), Math.floor(c.y / TILE), scanOf(up));

  p.drillSpin += (p.drilling ? 16 : 2.5) * dt;
  state.shake = Math.max(0, state.shake - dt * 22);
  state.nearPad = findPad(state);

  // Particles and toasts expire on the simulation clock, never on frame counts.
  for (let i = state.fx.length - 1; i >= 0; i--) {
    const f = state.fx[i];
    if (state.time >= f.until) { state.fx.splice(i, 1); continue; }
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (!f.text) f.vy += 260 * dt;
  }
  for (let i = state.toasts.length - 1; i >= 0; i--) {
    if (state.time >= state.toasts[i].until) state.toasts.splice(i, 1);
  }
}

function onSurface(state) {
  return state.player.y + PHYS.playerH <= SURFACE_Y + 2;
}

function findPad(state) {
  if (!onSurface(state)) return null;
  const cx = playerCenter(state.player).x;
  for (const pad of PADS) {
    const px = pad.x * TILE + TILE / 2;
    if (Math.abs(cx - px) < TILE * 1.3) return pad;
  }
  return null;
}

function tryDig(state, [dx, dy], dt) {
  const p = state.player;
  const drill = drillOf(state.upgrades);
  const target = pickDigTarget(state, dx, dy);

  if (!target) {
    state.dig.x = -1;
    state.dig.progress = 0;
    return;
  }
  const { tx, ty, hard, blocked } = target;
  if (blocked) {
    state.dig.x = -1;
    state.dig.progress = 0;
    if (state.time > (state.hardHintAt ?? 0)) {
      state.hardHintAt = state.time + 3;
      toast(state, `${drill.name} skids off this rock. You need a better drill head.`, 'bad');
    }
    return;
  }

  if (state.dig.x !== tx || state.dig.y !== ty) {
    state.dig.x = tx; state.dig.y = ty; state.dig.progress = 0;
  }
  p.drilling = true;
  emit(state, 'dig');
  state.dig.progress += dt * drill.power / (hard * PHYS.digBaseTime);

  // Ease the rig onto the tile it is cutting. Without this the hull can
  // straddle two tiles and the shaft wanders off the grid.
  if (dy > 0) {
    const want = tx * TILE + (TILE - PHYS.playerW) / 2;
    const diff = want - p.x;
    if (Math.abs(diff) > 0.5) p.x += Math.sign(diff) * Math.min(Math.abs(diff), 70 * dt);
  }

  if (Math.random() < dt * 26) {
    spark(state, tx * TILE + TILE / 2, ty * TILE + TILE / 2, tileSparkColor(tileAt(state.world, tx, ty)), 2, 60, 0.3);
  }

  if (state.dig.progress >= 1) breakTile(state, tx, ty);
}

// The rig is narrower than a tile, so its footprint can span two columns. Scan
// the whole face being pushed into and take the diggable tile nearest the
// centre — otherwise a rig resting on one tile drills at the empty one beside
// it and nothing happens at all.
function pickDigTarget(state, dx, dy) {
  const p = state.player;
  const drill = drillOf(state.upgrades);
  const cands = [];

  if (dy > 0) {
    const ty = Math.floor((p.y + PHYS.playerH + 3) / TILE);
    const cx = p.x + PHYS.playerW / 2;
    for (let tx = Math.floor(p.x / TILE); tx <= Math.floor((p.x + PHYS.playerW - 1) / TILE); tx++) {
      cands.push({ tx, ty, key: Math.abs((tx + 0.5) * TILE - cx) });
    }
  } else {
    const tx = Math.floor((dx < 0 ? p.x - 3 : p.x + PHYS.playerW + 3) / TILE);
    const cy = p.y + PHYS.playerH / 2;
    for (let ty = Math.floor(p.y / TILE); ty <= Math.floor((p.y + PHYS.playerH - 1) / TILE); ty++) {
      cands.push({ tx, ty, key: Math.abs((ty + 0.5) * TILE - cy) });
    }
  }
  cands.sort((a, b) => a.key - b.key);

  let blockedBy = null;
  for (const c of cands) {
    const tile = tileAt(state.world, c.tx, c.ty);
    if (!isDiggable(tile)) continue;
    const hard = hardnessAt(state.world, c.tx, c.ty);
    if (hard > drill.maxHardness) { blockedBy = blockedBy || { ...c, hard, blocked: true }; continue; }
    return { ...c, hard, blocked: false };
  }
  return blockedBy;
}

function tileSparkColor(tile) {
  if (isOre(tile)) return oreOf(tile).glow;
  return '#a08a6a';
}

export function breakTile(state, tx, ty, chained = false) {
  const world = state.world;
  const tile = tileAt(world, tx, ty);
  if (!isDiggable(tile)) return;

  world.tiles[idx(tx, ty)] = T.EMPTY;
  world.seen[idx(tx, ty)] = 1;
  state.dig.x = -1; state.dig.progress = 0;
  const wx = tx * TILE + TILE / 2, wy = ty * TILE + TILE / 2;

  if (tile === T.GAS) { explode(state, tx, ty); return; }

  if (tile === T.CORE) {
    state.status = 'won';
    emit(state, 'win');
    state.shake = 14;
    spark(state, wx, wy, '#ffd9a0', 60, 260, 1.4);
    toast(state, 'The Core is breached. You made it.', 'good');
    return;
  }

  if (isOre(tile)) {
    const o = oreOf(tile);
    const oi = ORES.indexOf(o);
    if (state.cargoCount < maxCargo(state.upgrades)) {
      state.cargo[oi]++;
      state.cargoCount++;
      state.stats.mined++;
      emit(state, o.value >= 700 ? 'gem' : 'ore');
      floater(state, wx, wy, o.name, o.glow);
      spark(state, wx, wy, o.glow, 10, 110, 0.6);
    } else {
      floater(state, wx, wy, 'CARGO FULL', '#ff6b6b');
    }
  } else if (!chained) {
    emit(state, 'break');
    spark(state, wx, wy, '#8b7355', 4, 70, 0.35);
  }

  // A gas pocket next door goes up with the tile you just removed.
  if (!chained) {
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (tileAt(world, tx + ox, ty + oy) === T.GAS) {
        world.tiles[idx(tx + ox, ty + oy)] = T.EMPTY;
        explode(state, tx + ox, ty + oy);
        break;
      }
    }
  }
}

function explode(state, tx, ty) {
  const wx = tx * TILE + TILE / 2, wy = ty * TILE + TILE / 2;
  const r = PHYS.gasRadius;
  for (let y = Math.floor(ty - r); y <= Math.ceil(ty + r); y++) {
    for (let x = Math.floor(tx - r); x <= Math.ceil(tx + r); x++) {
      const d = Math.hypot(x - tx, y - ty);
      if (d > r) continue;
      const t = tileAt(state.world, x, y);
      if (t === T.BEDROCK || t === T.CORE || t === T.CORESHELL) continue;
      if (isOre(t) && d > r * 0.6) continue;      // the blast leaves some ore
      breakTile(state, x, y, true);
    }
  }
  emit(state, 'explode');
  spark(state, wx, wy, '#ff9a3c', 34, 230, 1.0);
  const c = playerCenter(state.player);
  const dist = Math.hypot(c.x - wx, c.y - wy) / TILE;
  if (dist < r + 2.5) {
    damage(state, PHYS.gasDamage * Math.max(0.25, 1 - dist / (r + 2.5)), 'a gas pocket');
    state.player.vy -= 130;
  }
  state.shake = Math.max(state.shake, 11);
  toast(state, 'Gas pocket!', 'bad');
}

function hazards(state, dt) {
  const p = state.player;
  const x0 = Math.floor(p.x / TILE), x1 = Math.floor((p.x + PHYS.playerW - 1) / TILE);
  const y0 = Math.floor(p.y / TILE), y1 = Math.floor((p.y + PHYS.playerH - 1) / TILE);
  let inLava = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if (tileAt(state.world, x, y) === T.LAVA) inLava = true;
  }
  if (!inLava) return;
  damage(state, PHYS.lavaDamage * dt, 'the magma');
  if (Math.random() < dt * 6) emit(state, 'hurt');
  state.shake = Math.max(state.shake, 4);
  p.vy *= 0.86;                                   // magma is thick
  if (Math.random() < dt * 24) {
    spark(state, p.x + PHYS.playerW / 2, p.y + PHYS.playerH, '#ff7b39', 2, 60, 0.4);
  }
}

/* ----------------------------------------------------------------- actions */

export function sellAll(state) {
  const value = cargoValue(state);
  if (value <= 0) return { ok: false, msg: 'Nothing in the hold.' };
  const lines = [];
  for (let i = 0; i < ORES.length; i++) {
    if (state.cargo[i]) lines.push(`${state.cargo[i]}x ${ORES[i].name}`);
    state.cargo[i] = 0;
  }
  state.cargoCount = 0;
  state.money += value;
  state.stats.earned += value;
  toast(state, `Sold ${lines.join(', ')} for $${value.toLocaleString()}.`, 'good');
  return { ok: true, value };
}

export function refuel(state) {
  const p = state.player, cap = maxFuel(state.upgrades);
  const need = cap - p.fuel;
  if (need < 0.5) return { ok: false, msg: 'Tank is already full.' };
  const affordable = Math.min(need, state.money / PRICES.fuelPerUnit);
  if (affordable < 0.5) return { ok: false, msg: 'Not enough cash for fuel.' };
  const cost = Math.round(affordable * PRICES.fuelPerUnit);
  p.fuel += affordable;
  state.money -= cost;
  state.stats.spent += cost;
  state.stranded = false;
  toast(state, `Fuelled up for $${cost.toLocaleString()}.`, 'good');
  return { ok: true, cost };
}

export function repair(state) {
  const p = state.player, cap = maxHull(state.upgrades);
  const need = cap - p.hull;
  if (need < 0.5) return { ok: false, msg: 'Hull is intact.' };
  const affordable = Math.min(need, state.money / PRICES.repairPerHp);
  if (affordable < 0.5) return { ok: false, msg: 'Not enough cash for repairs.' };
  const cost = Math.round(affordable * PRICES.repairPerHp);
  p.hull += affordable;
  state.money -= cost;
  state.stats.spent += cost;
  toast(state, `Hull patched for $${cost.toLocaleString()}.`, 'good');
  return { ok: true, cost };
}

export function buyUpgrade(state, key) {
  const def = UPGRADES[key];
  const next = state.upgrades[key] + 1;
  if (next >= def.tiers.length) return { ok: false, msg: 'Already at the top tier.' };
  const tier = def.tiers[next];
  if (state.money < tier.cost) return { ok: false, msg: `Need $${tier.cost.toLocaleString()}.` };
  state.money -= tier.cost;
  state.stats.spent += tier.cost;
  state.upgrades[key] = next;
  // Capacity upgrades top up the thing they enlarge, so the buy feels immediate.
  if (key === 'fuel') state.player.fuel = maxFuel(state.upgrades);
  if (key === 'hull') state.player.hull = maxHull(state.upgrades);
  toast(state, `Fitted ${tier.name}.`, 'good');
  return { ok: true };
}

export function buyItem(state, key) {
  const def = ITEMS[key];
  if (state.money < def.cost) return { ok: false, msg: `Need $${def.cost.toLocaleString()}.` };
  state.money -= def.cost;
  state.stats.spent += def.cost;
  state.items[key]++;
  toast(state, `Bought ${def.name}.`, 'good');
  return { ok: true };
}

export function useItem(state, key) {
  if (!state.items[key]) return { ok: false, msg: `No ${ITEMS[key].name} aboard.` };
  const p = state.player;
  if (key === 'repair' && p.hull >= maxHull(state.upgrades)) {
    return { ok: false, msg: 'Hull is intact.' };
  }
  if (key === 'fuelcell' && p.fuel >= maxFuel(state.upgrades)) {
    return { ok: false, msg: 'Tank is full.' };
  }
  state.items[key]--;
  if (key === 'teleport') {
    toSurface(state);
    toast(state, 'Recall beacon fired.', 'good');
  } else if (key === 'repair') {
    p.hull = Math.min(maxHull(state.upgrades), p.hull + 60);
    toast(state, 'Patched +60 hull.', 'good');
  } else if (key === 'fuelcell') {
    p.fuel = Math.min(maxFuel(state.upgrades), p.fuel + 90);
    state.stranded = false;
    toast(state, 'Fuel cell drained into the tank.', 'good');
  }
  return { ok: true };
}

export function rescue(state) {
  const fee = Math.max(50, Math.round(state.money * 0.25));
  state.money = Math.max(0, state.money - fee);
  state.stats.spent += fee;
  toSurface(state);
  state.player.fuel = Math.max(state.player.fuel, maxFuel(state.upgrades) * 0.25);
  state.stranded = false;
  toast(state, `Rescue tug hauled you up. Fee: $${fee.toLocaleString()}.`, 'bad');
  return { ok: true, fee };
}

/* ------------------------------------------------------------ persistence */

export function serialize(state) {
  return {
    v: 1,
    coreKnown: state.coreKnown,
    seed: state.seed,
    time: state.time,
    money: state.money,
    upgrades: state.upgrades,
    items: state.items,
    cargo: Array.from(state.cargo),
    stats: state.stats,
    status: state.status,
    player: {
      x: state.player.x, y: state.player.y,
      fuel: state.player.fuel, hull: state.player.hull,
    },
    // Tiles are regenerated from the seed; only the diff is stored.
    dug: diffTiles(state.world),
    seen: packBits(state.world.seen),
  };
}

export function deserialize(save) {
  if (!save || save.v !== 1) return null;
  const state = createGame(save.seed);
  state.time = save.time || 0;
  state.money = save.money ?? START_MONEY;
  Object.assign(state.upgrades, save.upgrades || {});
  Object.assign(state.items, save.items || {});
  Object.assign(state.stats, save.stats || {});
  state.status = save.status === 'won' ? 'won' : 'playing';
  state.coreKnown = !!save.coreKnown;
  for (let i = 0; i < state.cargo.length; i++) state.cargo[i] = (save.cargo && save.cargo[i]) || 0;
  state.cargoCount = state.cargo.reduce((a, b) => a + b, 0);
  for (const i of save.dug || []) state.world.tiles[i] = T.EMPTY;
  if (save.seen) unpackBits(save.seen, state.world.seen);
  const p = save.player || {};
  state.player.x = p.x ?? SPAWN_X;
  state.player.y = p.y ?? SURFACE_Y - PHYS.playerH;
  state.player.fuel = Math.min(p.fuel ?? maxFuel(state.upgrades), maxFuel(state.upgrades));
  state.player.hull = Math.min(p.hull ?? maxHull(state.upgrades), maxHull(state.upgrades));
  return state;
}

function diffTiles(world) {
  const fresh = generateWorld(world.seed).tiles;
  const dug = [];
  for (let i = 0; i < world.tiles.length; i++) {
    if (world.tiles[i] !== fresh[i]) dug.push(i);
  }
  return dug;
}

function packBits(arr) {
  let out = '';
  for (let i = 0; i < arr.length; i += 6) {
    let v = 0;
    for (let b = 0; b < 6; b++) if (arr[i + b]) v |= 1 << b;
    out += String.fromCharCode(48 + v);
  }
  return out;
}

function unpackBits(str, arr) {
  for (let i = 0; i < str.length; i++) {
    const v = str.charCodeAt(i) - 48;
    for (let b = 0; b < 6; b++) {
      const j = i * 6 + b;
      if (j < arr.length) arr[j] = (v >> b) & 1;
    }
  }
}
