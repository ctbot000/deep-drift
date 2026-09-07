// Headless playtest. Drives js/sim.js with a bot that plays roughly the way a
// person does — dig down, detour to scanned ore, follow the tunnels home — to
// check that the game is winnable and paced, and that the fixed-step loop is
// frame-rate independent.
//
//   node tools/balance.mjs            # default seeds
//   node tools/balance.mjs 11 12 13   # specific seeds

import {
  TILE, T, UPGRADES, PHYS, FUEL, SURFACE_ROW,
  maxFuel, maxHull, maxCargo, drillOf, engineOf, scanOf, bandHardness,
} from '../js/config.js';
import {
  createGame, newInput, step, sellAll, refuel, repair,
  buyUpgrade, buyItem, useItem, rescue, SURFACE_Y, playerCenter,
} from '../js/sim.js';
import { tileAt, isOre, isSolid, hardnessAt } from '../js/world.js';

const FIXED_DT = 1 / 120;
const DECISION = 0.1;
const MAX_SIM_SECONDS = 60 * 150;

const col = (s) => Math.floor(playerCenter(s.player).x / TILE);
const row = (s) => Math.floor(playerCenter(s.player).y / TILE);
const atSurface = (s) => s.player.y + PHYS.playerH <= SURFACE_Y + 2;

// Fuel held back for the climb home, with a safety factor.
function climbCost(state) {
  const seconds = (state.depth * TILE) / (PHYS.maxThrustUp * engineOf(state.upgrades));
  return seconds * (FUEL.thrust + FUEL.idle) * 1.6 + 10;
}

/* ------------------------------------------------------------------ policy */

function doBase(state, log) {
  sellAll(state);
  refuel(state);
  repair(state);

  // Ask the band, not a specific tile: the tile below the deepest point is
  // often an empty cave, which reads as "nothing blocking me". Look ahead, so
  // the drill is bought before the rig is standing on rock it cannot cut.
  const hard = bandHardness(Math.round(state.stats.deepest) + 15);
  const blocked = drillOf(state.upgrades).maxHardness < hard;

  const order = blocked
    ? ['drill', 'fuel', 'cargo', 'hull', 'engine', 'scanner']
    : ['cargo', 'fuel', 'drill', 'engine', 'scanner', 'hull'];

  let bought = true;
  while (bought) {
    bought = false;
    for (const key of order) {
      const next = UPGRADES[key].tiers[state.upgrades[key] + 1];
      if (!next) continue;
      if (state.money < next.cost) {
        if (blocked && key === 'drill') return;   // save for the drill
        continue;
      }
      if (buyUpgrade(state, key).ok) {
        log.push({ t: state.time, buy: `${key}${state.upgrades[key]}`, cost: next.cost });
        bought = true;
        break;
      }
    }
  }
  const rich = state.money > 1200 + state.stats.deepest * 8;
  if (rich && state.items.teleport < 2) buyItem(state, 'teleport');
  if (rich && state.items.fuelcell < 1) buyItem(state, 'fuelcell');
}

// Nearest scanned ore at or below the rig. Committed to, so it does not
// oscillate between two equally close veins.
function pickOre(state, c, r, hunt) {
  const maxHard = drillOf(state.upgrades).maxHardness;
  if (hunt.x >= 0 && state.time < hunt.until) {
    const t = tileAt(state.world, hunt.x, hunt.y);
    if (isOre(t) && hardnessAt(state.world, hunt.x, hunt.y) <= maxHard && hunt.y >= r - 2) {
      return [hunt.x, hunt.y];
    }
  }
  const R = Math.ceil(scanOf(state.upgrades));
  let best = null, bestD = Infinity;
  for (let y = r - 2; y <= r + R; y++) {
    for (let x = c - R; x <= c + R; x++) {
      const t = tileAt(state.world, x, y);
      if (!isOre(t) || hardnessAt(state.world, x, y) > maxHard) continue;
      const d = Math.abs(x - c) * 1.9 + Math.abs(y - r) * (y < r ? 3 : 1);  // sideways and upward cost more
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  if (best) { hunt.x = best[0]; hunt.y = best[1]; hunt.until = state.time + 20; }
  else hunt.x = -1;
  return best;
}

// Breadth-first route home through open tunnels: you cannot drill upwards, so
// the only way out is the way you came.
function pathHome(state, c, r) {
  const w = state.world.w, h = state.world.h;
  const from = new Int32Array(w * h).fill(-1);
  const start = r * w + c;
  const queue = [start];
  from[start] = start;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const cy = (cur / w) | 0, cx = cur % w;
    if (cy <= SURFACE_ROW) {
      const path = [];
      for (let n = cur; n !== start; n = from[n]) path.push([n % w, (n / w) | 0]);
      return path.reverse();
    }
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (from[n] !== -1) continue;
      const t = tileAt(state.world, nx, ny);
      if (isSolid(t) || t === T.LAVA) continue;
      from[n] = cur;
      queue.push(n);
    }
  }
  return null;
}

/* -------------------------------------------------------------------- game */

function playOne(seed) {
  const state = createGame(seed);
  const input = newInput();
  const log = [];
  const hunt = { x: -1, y: -1, until: 0 };
  let phase = 'base';
  let nextDecision = 0, upSince = 0;
  let route = null, routeAt = 0;
  let wander = 0, wanderUntil = 0;
  let wrecks = 0, lastDeep = 0, lastEarned = 0, progressAt = 0;
  const phaseTime = { base: 0, down: 0, up: 0 };
  let trace = [];

  while (state.time < MAX_SIM_SECONDS && state.status === 'playing') {
    if (state.time >= nextDecision) {
      nextDecision = state.time + DECISION;
      input.left = input.right = input.up = input.down = false;
      const c = col(state), r = row(state);

      if (state.stranded && !atSurface(state)) {
        if (state.items.fuelcell) useItem(state, 'fuelcell');
        else rescue(state);
        route = null;
        phase = 'base';
      } else if (phase === 'base') {
        if (atSurface(state)) { doBase(state, log); phase = 'down'; route = null; }
        else input.up = true;
      } else if (phase === 'down') {
        const full = state.cargoCount >= maxCargo(state.upgrades);
        const low = state.player.fuel <= climbCost(state);
        const hurt = state.player.hull < maxHull(state.upgrades) * 0.3;
        const chasing = state.coreKnown && drillOf(state.upgrades).maxHardness >= 6
          && state.player.fuel > 120;
        if ((full || low || hurt) && !chasing) {
          if (state.items.teleport) { useItem(state, 'teleport'); phase = 'base'; }
          else { phase = 'up'; upSince = state.time; route = null; }
        } else {
          // Once the anomaly announces itself, stop shopping and go for it.
          const coreRun = state.coreKnown
            && drillOf(state.upgrades).maxHardness >= 6
            && state.player.fuel > 120;
          if (coreRun) {
            const cx = state.world.coreX, cy = state.world.coreY;
            if (Math.abs(c - cx) > 0 && r < cy - 2) {
              if (c < cx) input.right = true; else input.left = true;
            } else if (r < cy) input.down = true;
            else if (c < cx) input.right = true;
            else if (c > cx) input.left = true;
            else input.down = true;
            step(state, FIXED_DT, input);
            continue;
          }
          const belowHard = hardnessAt(state.world, c, r + 1);
          const floorTooHard = Number.isFinite(belowHard)
            && belowHard > drillOf(state.upgrades).maxHardness;
          const target = pickOre(state, c, r, hunt);
          const downIsLava = tileAt(state.world, c, r + 1) === T.LAVA
            || tileAt(state.world, c, r + 2) === T.LAVA;
          if (downIsLava) {
            // Step around the pool rather than into it.
            const leftOk = tileAt(state.world, c - 1, r) !== T.LAVA;
            if (leftOk) input.left = true; else input.right = true;
          } else if (!target) {
            // Nothing worth cutting below: drift along the band looking for a
            // vein rather than grinding into rock the drill cannot bite.
            if (floorTooHard) {
              if (wander === 0 || state.time > wanderUntil) {
                wander = c < state.world.w / 2 ? 1 : -1;
                wanderUntil = state.time + 12;
              }
              if (wander < 0) input.left = true; else input.right = true;
            } else input.down = true;
          }
          else if (target[1] > r && !floorTooHard) input.down = true;   // close the vertical gap first
          else if (target[1] > r && floorTooHard) { if (target[0] < c) input.left = true; else input.right = true; }
          else if (target[0] < c) input.left = true;
          else if (target[0] > c) input.right = true;
          else input.down = true;
        }
      } else if (phase === 'up') {
        if (atSurface(state)) { phase = 'base'; route = null; }
        else if (state.items.teleport && state.time - upSince > 90) {
          useItem(state, 'teleport'); phase = 'base'; route = null;
        } else {
          if (!route || route.length === 0 || state.time > routeAt + 2) {
            route = pathHome(state, c, r);
            routeAt = state.time;
          }
          if (!route) {
            input.down = true;                        // sealed in; dig on
          } else {
            while (route.length && route[0][0] === c && route[0][1] === r) route.shift();
            const next = route[0];
            if (!next) input.up = true;
            else {
              if (next[0] < c) input.left = true;
              else if (next[0] > c) input.right = true;
              if (next[1] <= r) input.up = true;
            }
          }
        }
      }
    }

    phaseTime[phase] = (phaseTime[phase] || 0) + FIXED_DT;
    if (process.env.TRACE && trace.length < 400 && (!trace.length || state.time - trace[trace.length-1].t > 5)) {
      trace.push({ t: +state.time.toFixed(0), phase, d: +state.depth.toFixed(0), f: +state.player.fuel.toFixed(0), h: +state.player.hull.toFixed(0), c: state.cargoCount, m: Math.round(state.money) });
    }
    step(state, FIXED_DT, input);

    if (state.stats.wrecks !== wrecks) { wrecks = state.stats.wrecks; phase = 'base'; route = null; }
    // Progress is depth OR money: a rig saving up for the next drill head is
    // still playing, it just is not getting deeper yet.
    if (state.stats.deepest > lastDeep + 0.5 || state.stats.earned > lastEarned + 1) {
      lastDeep = Math.max(lastDeep, state.stats.deepest);
      lastEarned = Math.max(lastEarned, state.stats.earned);
      progressAt = state.time;
    }
    if (state.time - progressAt > 900) break;
  }
  return { state, log, phaseTime, trace, stalled: state.status === 'playing' };
}

/* ------------------------------------------------------------------ report */

const fmt = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
const seeds = process.argv[2] ? process.argv.slice(2).map(Number) : [1, 2, 3, 4, 5, 6];
let wins = 0;
const times = [];

for (const seed of seeds) {
  const { state, log, phaseTime, trace, stalled } = playOne(seed);
  const s = state.stats;
  if (state.status === 'won') { wins++; times.push(s.playTime); }
  console.log(
    `seed ${String(seed).padStart(3)} ${state.status === 'won' ? 'WON  ' : stalled ? 'STALL' : 'end  '}` +
    ` ${fmt(s.playTime).padStart(9)}  deepest ${String(Math.round(s.deepest)).padStart(3)}m` +
    `  earned $${Math.round(s.earned).toLocaleString().padStart(9)}` +
    `  cash $${Math.round(state.money).toLocaleString().padStart(8)}` +
    `  wrecks ${String(s.wrecks).padStart(2)}  ore ${String(s.mined).padStart(4)}` +
    `  [${Object.keys(UPGRADES).map((k) => `${k[0]}${state.upgrades[k]}`).join(' ')}]`);
  if (process.env.PHASES) {
    console.log('        phase seconds: ' + Object.entries(phaseTime).map(([k, v]) => `${k}=${Math.round(v)}`).join(' '));
  }
  if (process.env.TRACE) trace.slice(0, 60).forEach((r) => console.log('        ', JSON.stringify(r)));
}
console.log(`\n${wins}/${seeds.length} seeds reached the Core` +
  (times.length ? `, median ${fmt(times.sort((a, b) => a - b)[times.length >> 1])}` : ''));

/* ------------------------------------------- loop-invariance and unit checks */

// The app always steps at FIXED_DT and carries the remainder in an accumulator,
// so the same wall time chopped into different frames must land in one place.
function driveFrames(frameDt, seconds) {
  const state = createGame(99);
  const input = newInput();
  input.down = true;
  let acc = 0;
  for (let t = 0; t < seconds; t += frameDt) {
    acc += frameDt;
    while (acc >= FIXED_DT) { step(state, FIXED_DT, input); acc -= FIXED_DT; }
  }
  return state;
}

const depths = [1 / 30, 1 / 60, 1 / 144].map((d) => driveFrames(d, 20).depth);
const spread = Math.max(...depths) - Math.min(...depths);
console.log(`\nfixed-step invariance: 20s of drilling -> ` +
  depths.map((d, i) => `${d.toFixed(2)}m @${[30, 60, 144][i]}Hz`).join(', ') +
  `  (spread ${spread.toFixed(3)}m)`);

let fail = false;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) fail = true; };

console.log('\nchecks:');
check(spread < 0.3, 'frame size does not change the simulation');
check(Math.min(...depths) > 5, 'the rig actually digs at every frame size');
check(wins > 0, 'at least one seed reaches the Core');

const fuelState = driveFrames(1 / 60, 20);
check(fuelState.player.fuel < maxFuel(fuelState.upgrades), 'fuel is consumed while drilling');

// A backwards timestamp must not drive the loop negative and silently stop it.
const s2 = createGame(5);
const i2 = newInput(); i2.down = true;
for (let k = 0; k < 200; k++) step(s2, FIXED_DT, i2);
const before = s2.depth;
step(s2, -1, i2);
for (let k = 0; k < 200; k++) step(s2, FIXED_DT, i2);
check(s2.depth > before, 'a negative dt does not stall the simulation');

process.exit(fail ? 1 : 0);
