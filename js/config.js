// Static game data: tiles, ores, upgrades, items and physics constants.
// Pure data + pure helpers only — this module must stay DOM-free so the
// simulation can be driven headlessly by tools/balance.mjs.

export const TILE = 32;
export const WORLD_W = 48;
export const SURFACE_ROW = 6;          // first solid row; depth 0 m
export const WORLD_DEPTH = 256;        // depths 0 .. 255 m
export const WORLD_H = SURFACE_ROW + WORLD_DEPTH;

export const T = {
  EMPTY: 0,
  DIRT: 1,
  ROCK: 2,
  DENSE: 3,
  OBSIDIAN: 4,
  MAGMA: 5,
  CORESHELL: 6,
  BEDROCK: 7,
  LAVA: 8,
  GAS: 9,
  CORE: 10,
  ORE: 16,                             // ORE + oreIndex
};

// Hardness of the plain rock types. Ore tiles inherit the hardness of the
// band they are embedded in, so a gold vein in obsidian is obsidian-hard.
export const ROCK_HARDNESS = {
  [T.DIRT]: 1,
  [T.ROCK]: 2,
  [T.DENSE]: 3,
  [T.OBSIDIAN]: 4,
  [T.MAGMA]: 5,
  [T.CORESHELL]: 6,
  [T.CORE]: 6,
  [T.GAS]: 1,
};

export const BANDS = [
  { until: 35,  tile: T.DIRT },
  { until: 85,  tile: T.ROCK },
  { until: 140, tile: T.DENSE },
  { until: 190, tile: T.OBSIDIAN },
  { until: 240, tile: T.MAGMA },
  { until: 999, tile: T.CORESHELL },
];

export function bandTile(depth) {
  for (const b of BANDS) if (depth < b.until) return b.tile;
  return T.CORESHELL;
}

export function bandHardness(depth) {
  return ROCK_HARDNESS[bandTile(depth)];
}

export const ORES = [
  { key: 'coal',      name: 'Coal',      value: 15,   min: 2,   max: 70,  peak: 20,  freq: 0.085, color: '#3d3f47', glow: '#6b6f7a' },
  { key: 'copper',    name: 'Copper',    value: 40,   min: 8,   max: 110, peak: 45,  freq: 0.065, color: '#c1743a', glow: '#ffb072' },
  { key: 'iron',      name: 'Iron',      value: 90,   min: 25,  max: 155, peak: 80,  freq: 0.050, color: '#b0a89c', glow: '#e6ded2' },
  { key: 'silver',    name: 'Silver',    value: 190,  min: 55,  max: 195, peak: 115, freq: 0.038, color: '#cfd8e3', glow: '#ffffff' },
  { key: 'gold',      name: 'Gold',      value: 400,  min: 85,  max: 235, peak: 150, freq: 0.030, color: '#e8b73a', glow: '#fff0a8' },
  { key: 'platinum',  name: 'Platinum',  value: 850,  min: 125, max: 255, peak: 190, freq: 0.028, color: '#8fd9d0', glow: '#d8fffb' },
  { key: 'emerald',   name: 'Emerald',   value: 1600, min: 155, max: 255, peak: 215, freq: 0.019, color: '#3ad17a', glow: '#a8ffcd' },
  { key: 'diamond',   name: 'Diamond',   value: 3400, min: 185, max: 255, peak: 235, freq: 0.012, color: '#7fe4ff', glow: '#e6fbff' },
  { key: 'aetherium', name: 'Aetherium', value: 9000, min: 225, max: 255, peak: 252, freq: 0.0075, color: '#c07dff', glow: '#f2ddff' },
];

export const UPGRADES = {
  drill: {
    name: 'Drill Head',
    blurb: 'Cuts faster and bites into harder rock.',
    tiers: [
      { name: 'Iron Bit',     cost: 0,     power: 1.0, maxHardness: 2 },
      { name: 'Steel Bit',    cost: 320,   power: 1.55, maxHardness: 3 },
      { name: 'Carbide Bit',  cost: 1150,  power: 2.30, maxHardness: 4 },
      { name: 'Diamond Bit',  cost: 3900,  power: 3.30, maxHardness: 5 },
      { name: 'Plasma Lance', cost: 11500, power: 4.60, maxHardness: 6 },
      { name: 'Void Auger',   cost: 26000, power: 6.40, maxHardness: 6 },
    ],
  },
  fuel: {
    name: 'Fuel Tank',
    blurb: 'Every metre down is a metre you still have to climb.',
    tiers: [
      { name: 'Stock Tank',   cost: 0,     capacity: 100 },
      { name: 'Extended',     cost: 200,   capacity: 155 },
      { name: 'Twin Cell',    cost: 680,   capacity: 230 },
      { name: 'Long Haul',    cost: 2200,  capacity: 330 },
      { name: 'Deepcore',     cost: 6200,  capacity: 470 },
      { name: 'Abyssal',      cost: 14500, capacity: 660 },
    ],
  },
  hull: {
    name: 'Hull Plating',
    blurb: 'Survives longer falls and hotter neighbourhoods.',
    tiers: [
      { name: 'Tin Shell',    cost: 0,     hp: 100 },
      { name: 'Riveted',      cost: 230,   hp: 165 },
      { name: 'Layered',      cost: 800,   hp: 245 },
      { name: 'Ceramic',      cost: 2500,  hp: 370 },
      { name: 'Ablative',     cost: 7000,  hp: 530 },
      { name: 'Monoblock',    cost: 16500, hp: 760 },
    ],
  },
  cargo: {
    name: 'Cargo Bay',
    blurb: 'How much you can carry back up in one trip.',
    tiers: [
      { name: 'Crate',        cost: 0,     capacity: 12 },
      { name: 'Hopper',       cost: 210,   capacity: 20 },
      { name: 'Double Bay',   cost: 750,   capacity: 33 },
      { name: 'Freight Bay',  cost: 2400,  capacity: 52 },
      { name: 'Bulk Hold',    cost: 6800,  capacity: 78 },
      { name: 'Leviathan',    cost: 16000, capacity: 115 },
    ],
  },
  engine: {
    name: 'Engine',
    blurb: 'Thrust and top speed. Time is fuel.',
    tiers: [
      { name: 'Worn Turbine', cost: 0,     mult: 1.00 },
      { name: 'Tuned',        cost: 185,   mult: 1.14 },
      { name: 'Bored Out',    cost: 660,   mult: 1.30 },
      { name: 'Twin Rotor',   cost: 2100,  mult: 1.48 },
      { name: 'Ion Drive',    cost: 6000,  mult: 1.70 },
      { name: 'Skyhook',      cost: 14000, mult: 1.95 },
    ],
  },
  scanner: {
    name: 'Scanner',
    blurb: 'Sees ore through solid rock. Deeper radius, fewer dry shafts.',
    tiers: [
      { name: 'Cracked Lens', cost: 0,     radius: 7.0 },
      { name: 'Sonar Mk I',   cost: 150,   radius: 9.0 },
      { name: 'Sonar Mk II',  cost: 540,   radius: 11.5 },
      { name: 'Deep Echo',    cost: 1700,  radius: 14.0 },
      { name: 'Resonator',    cost: 4800,  radius: 17.0 },
      { name: 'Oracle Array', cost: 12000, radius: 21.0 },
    ],
  },
};

export const ITEMS = {
  teleport: { name: 'Recall Beacon', cost: 380, blurb: 'Snap back to the surface instantly.', key: '1' },
  repair:   { name: 'Patch Kit',     cost: 300, blurb: 'Welds 60 hull back on, anywhere.',    key: '2' },
  fuelcell: { name: 'Fuel Cell',     cost: 260, blurb: 'Pours 90 fuel into the tank.',        key: '3' },
};

export const PADS = [
  { key: 'market', name: 'Ore Market',  x: 7,  color: '#e8b73a', hint: 'Sell your haul' },
  { key: 'depot',  name: 'Fuel Depot',  x: 14, color: '#5fd0f0', hint: 'Refuel & repair' },
  { key: 'shop',   name: 'Workshop',    x: 21, color: '#ff8a4c', hint: 'Rig upgrades' },
  { key: 'store',  name: 'Supply Hut',  x: 28, color: '#8fe58a', hint: 'Field consumables' },
];

export const PHYS = {
  gravity: 900,
  maxFall: 640,
  moveAccel: 1500,
  moveMax: 195,
  groundFriction: 1900,
  airFriction: 420,
  thrust: 1620,
  maxThrustUp: 235,
  playerW: 24,
  playerH: 26,
  digBaseTime: 0.45,        // seconds per hardness point at drill power 1.0
  fallDamageSpeed: 520,
  fallDamageScale: 0.10,
  lavaDamage: 40,           // hull per second
  gasDamage: 34,
  gasRadius: 2.4,
};

export const FUEL = {
  idle: 0.22,
  move: 0.40,
  thrust: 2.70,
  drill: 0.60,
};

export const PRICES = {
  fuelPerUnit: 1.0,
  repairPerHp: 1.2,
};

export const START_MONEY = 120;

export function drillOf(up)   { return UPGRADES.drill.tiers[up.drill]; }
export function maxFuel(up)   { return UPGRADES.fuel.tiers[up.fuel].capacity; }
export function maxHull(up)   { return UPGRADES.hull.tiers[up.hull].hp; }
export function maxCargo(up)  { return UPGRADES.cargo.tiers[up.cargo].capacity; }
export function engineOf(up)  { return UPGRADES.engine.tiers[up.engine].mult; }
export function scanOf(up)    { return UPGRADES.scanner.tiers[up.scanner].radius; }
