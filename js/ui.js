// DOM heads-up display, base panels and toasts.

import {
  ORES, UPGRADES, ITEMS, PRICES, TILE, PHYS, SURFACE_ROW, maxFuel, maxHull, maxCargo,
} from './config.js';
import {
  cargoValue, sellAll, refuel, repair, buyUpgrade, buyItem, useItem, rescue,
} from './sim.js';
import { sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
// The pad is captured when the panel opens: reading state.nearPad live would
// empty the panel the moment the rig drifts off the pad.
let openPad = null;

export function isPanelOpen() { return openPad !== null; }

export function closePanel() {
  openPad = null;
  $('panel').classList.add('hidden');
}

export function togglePanel(state) {
  if (openPad) { closePanel(); sfx('click'); return; }
  if (!state.nearPad) return;
  openPad = state.nearPad;
  sfx('click');
  renderPanel(state);
  $('panel').classList.remove('hidden');
}

const money = (n) => '$' + Math.round(n).toLocaleString();

export function updateHud(state) {
  const p = state.player;
  const fMax = maxFuel(state.upgrades), hMax = maxHull(state.upgrades), cMax = maxCargo(state.upgrades);
  bar('fuel', p.fuel / fMax, `${Math.ceil(p.fuel)} / ${fMax}`);
  bar('hull', p.hull / hMax, `${Math.ceil(p.hull)} / ${hMax}`);
  bar('cargo', state.cargoCount / cMax, `${state.cargoCount} / ${cMax}`);
  $('money').textContent = money(state.money);
  $('haul').textContent = state.cargoCount ? money(cargoValue(state)) : '—';
  $('depth').textContent = Math.round(state.depth) + ' m';
  $('best').textContent = Math.round(state.stats.deepest) + ' m';

  const core = $('core-bearing');
  if (state.coreKnown && state.status === 'playing') {
    const dx = state.world.coreX - Math.floor((p.x + PHYS.playerW / 2) / TILE);
    const dy = Math.max(0, Math.round(state.world.coreY - SURFACE_ROW - state.depth));
    core.querySelector('.v').textContent =
      (dx === 0 ? '▼' : dx < 0 ? `◀ ${Math.abs(dx)} m` : `${dx} m ▶`) + (dy > 2 ? `  ▼ ${dy} m` : '');
    core.classList.remove('hidden');
  } else {
    core.classList.add('hidden');
  }

  for (const k of Object.keys(ITEMS)) {
    const el = $('item-' + k);
    if (!el) continue;
    el.querySelector('.count').textContent = state.items[k];
    el.classList.toggle('empty', state.items[k] === 0);
  }

  const prompt = $('prompt');
  if (state.stranded && !openPad) {
    prompt.innerHTML = 'Out of fuel — <b>press R</b> for a rescue tug (25% of your cash)';
    prompt.classList.remove('hidden');
  } else if (state.nearPad && !openPad) {
    prompt.innerHTML = `<b>${state.nearPad.name}</b> — press <b>E</b> to ${state.nearPad.hint.toLowerCase()}`;
    prompt.classList.remove('hidden');
  } else {
    prompt.classList.add('hidden');
  }

  const list = $('toasts');
  list.innerHTML = '';
  for (const t of state.toasts) {
    const li = document.createElement('li');
    li.className = 'toast ' + t.kind;
    li.textContent = t.text;
    list.appendChild(li);
  }

  if (openPad) refreshPanelNumbers(state);
}

function bar(name, frac, label) {
  const el = $('bar-' + name);
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  el.querySelector('.fill').style.width = pct.toFixed(1) + '%';
  el.querySelector('.val').textContent = label;
  el.classList.toggle('low', frac < 0.22);
}

/* ----------------------------------------------------------------- panels */

function renderPanel(state) {
  const body = $('panel-body');
  const pad = openPad;
  $('panel-title').textContent = pad ? pad.name : '';
  body.innerHTML = '';
  if (!pad) return;
  if (pad.key === 'market') body.appendChild(marketPanel(state));
  else if (pad.key === 'depot') body.appendChild(depotPanel(state));
  else if (pad.key === 'shop') body.appendChild(shopPanel(state));
  else if (pad.key === 'store') body.appendChild(storePanel(state));
}

function act(state, fn) {
  const r = fn();
  sfx(r && r.ok === false ? 'deny' : 'buy');
  renderPanel(state);
  updateHud(state);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, disabled, onClick) {
  const b = el('button', 'btn', label);
  b.disabled = !!disabled;
  b.addEventListener('click', onClick);
  return b;
}

function marketPanel(state) {
  const wrap = el('div');
  const table = el('div', 'rows');
  let any = false;
  for (let i = 0; i < ORES.length; i++) {
    if (!state.cargo[i]) continue;
    any = true;
    const row = el('div', 'row');
    const sw = el('span', 'swatch');
    sw.style.background = ORES[i].color;
    sw.style.boxShadow = `0 0 8px ${ORES[i].glow}`;
    row.appendChild(sw);
    row.appendChild(el('span', 'grow', `${ORES[i].name} x${state.cargo[i]}`));
    row.appendChild(el('span', 'num', money(state.cargo[i] * ORES[i].value)));
    table.appendChild(row);
  }
  if (!any) table.appendChild(el('p', 'muted', 'The hold is empty. Go dig something up.'));
  wrap.appendChild(table);

  const total = cargoValue(state);
  const foot = el('div', 'foot');
  foot.appendChild(el('span', 'total', 'Total ' + money(total)));
  foot.appendChild(button('Sell everything', total <= 0, () => act(state, () => {
    const r = sellAll(state);
    if (r.ok) sfx('sell');
    return r;
  })));
  wrap.appendChild(foot);

  const prices = el('div', 'pricelist');
  prices.appendChild(el('h4', null, 'Standing prices'));
  for (const o of ORES) {
    const r = el('div', 'row small');
    const sw = el('span', 'swatch');
    sw.style.background = o.color;
    r.appendChild(sw);
    r.appendChild(el('span', 'grow', o.name));
    r.appendChild(el('span', 'num', money(o.value)));
    prices.appendChild(r);
  }
  wrap.appendChild(prices);
  return wrap;
}

function depotPanel(state) {
  const wrap = el('div');
  const p = state.player;
  const fuelNeed = maxFuel(state.upgrades) - p.fuel;
  const hullNeed = maxHull(state.upgrades) - p.hull;

  const f = el('div', 'row');
  f.appendChild(el('span', 'grow', `Refuel — ${Math.ceil(fuelNeed)} units at $${PRICES.fuelPerUnit.toFixed(2)}`));
  f.appendChild(el('span', 'num', money(fuelNeed * PRICES.fuelPerUnit)));
  f.appendChild(button('Fill', fuelNeed < 0.5, () => act(state, () => refuel(state))));
  wrap.appendChild(f);

  const h = el('div', 'row');
  h.appendChild(el('span', 'grow', `Repair — ${Math.ceil(hullNeed)} hull at $${PRICES.repairPerHp.toFixed(2)}`));
  h.appendChild(el('span', 'num', money(hullNeed * PRICES.repairPerHp)));
  h.appendChild(button('Weld', hullNeed < 0.5, () => act(state, () => repair(state))));
  wrap.appendChild(h);

  wrap.appendChild(el('p', 'muted', 'Both fill as far as your cash goes. Sitting on the pad burns no fuel.'));
  return wrap;
}

function shopPanel(state) {
  const wrap = el('div', 'rows');
  for (const key of Object.keys(UPGRADES)) {
    const def = UPGRADES[key];
    const lvl = state.upgrades[key];
    const cur = def.tiers[lvl];
    const next = def.tiers[lvl + 1];
    const row = el('div', 'upgrade');

    const head = el('div', 'uhead');
    head.appendChild(el('span', 'uname', def.name));
    head.appendChild(el('span', 'pips', '●'.repeat(lvl + 1) + '○'.repeat(def.tiers.length - lvl - 1)));
    row.appendChild(head);
    row.appendChild(el('div', 'ublurb', def.blurb));
    row.appendChild(el('div', 'ucur', `Fitted: ${cur.name} — ${describe(key, cur)}`));

    if (next) {
      const line = el('div', 'row');
      line.appendChild(el('span', 'grow', `${next.name} — ${describe(key, next)}`));
      line.appendChild(el('span', 'num', money(next.cost)));
      line.appendChild(button('Fit', state.money < next.cost, () => act(state, () => buyUpgrade(state, key))));
      row.appendChild(line);
    } else {
      row.appendChild(el('div', 'maxed', 'Fully upgraded'));
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function describe(key, tier) {
  switch (key) {
    case 'drill': return `power ${tier.power.toFixed(2)}, cuts hardness ${tier.maxHardness}`;
    case 'fuel': return `${tier.capacity} fuel`;
    case 'hull': return `${tier.hp} hull`;
    case 'cargo': return `${tier.capacity} ore`;
    case 'engine': return `${Math.round(tier.mult * 100)}% thrust & speed`;
    case 'scanner': return `${tier.radius.toFixed(1)} tile radius`;
    default: return '';
  }
}

function storePanel(state) {
  const wrap = el('div', 'rows');
  for (const key of Object.keys(ITEMS)) {
    const def = ITEMS[key];
    const row = el('div', 'row');
    row.appendChild(el('span', 'grow', `${def.name} — ${def.blurb} (key ${def.key})`));
    row.appendChild(el('span', 'num', `x${state.items[key]}`));
    row.appendChild(el('span', 'num', money(def.cost)));
    row.appendChild(button('Buy', state.money < def.cost, () => act(state, () => buyItem(state, key))));
    wrap.appendChild(row);
  }
  wrap.appendChild(el('p', 'muted', 'Consumables work anywhere. A Recall Beacon is usually cheaper than the climb home.'));
  return wrap;
}

function refreshPanelNumbers(state) {
  $('panel-money').textContent = money(state.money);
}

/* ------------------------------------------------------------- item hotkey */

export function useItemKey(state, key) {
  const r = useItem(state, key);
  sfx(r.ok ? 'buy' : 'deny');
  return r;
}

export function tryRescue(state) {
  if (!state.stranded) return;
  rescue(state);
  sfx('wreck');
}
