// WebGL2 renderer. The world is drawn as instanced boxes: solid rock is a wall
// of blocks with its front face toward the camera, and everything you have dug
// is a corridor carved into it, lit by the rig's headlamp.
//
// The simulation is untouched and still thinks in 2D pixels; this module
// converts. One tile = one world unit, and world Y points up, so a depth in
// metres is a negative Y.

import {
  TILE, T, SURFACE_ROW, WORLD_W, WORLD_H, PADS, PHYS, scanOf,
} from './config.js';
import { isOre, oreOf, idx } from './world.js';
import { playerCenter } from './sim.js';
import { perspective, lookAt, multiply } from './mat4.js';

/* --------------------------------------------------------------- geometry */

const BLOCK_FRONT = 0.5;      // rock face nearest the camera
const BLOCK_BACK = -1.1;      // how deep the rock slab goes
const BLOCK_DEPTH = BLOCK_FRONT - BLOCK_BACK;
const BLOCK_CZ = (BLOCK_FRONT + BLOCK_BACK) / 2;
const BACKDROP_Z = BLOCK_BACK - 0.05;
const FOV = 0.95;             // radians

// The rig sits inside the slab, so a corridor genuinely encloses it.
const RIG_Z = -0.1;

/* ---------------------------------------------------------------- shaders */

const BLOCK_VS = `#version 300 es
in vec3 a_pos;
in vec3 a_normal;
in vec3 i_offset;
in vec3 i_scale;
in vec3 i_color;
in vec2 i_extra;              // x: emissive, y: rotation about Y
uniform mat4 u_viewProj;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
out float v_emissive;
void main() {
  float c = cos(i_extra.y), s = sin(i_extra.y);
  mat3 rot = mat3(c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c);
  vec3 p = rot * (a_pos * i_scale) + i_offset;
  v_world = p;
  v_normal = rot * (a_normal / max(i_scale, vec3(1e-4)));
  v_color = i_color;
  v_emissive = i_extra.x;
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const BLOCK_FS = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_emissive;
uniform vec3 u_lampPos;
uniform vec3 u_lampColor;
uniform float u_lampPower;
uniform float u_ambient;
uniform vec3 u_ambientTint;
uniform vec3 u_fogColor;
uniform vec3 u_eye;
uniform float u_fogNear;
uniform float u_fogFar;
out vec4 outColor;
void main() {
  vec3 N = normalize(v_normal);

  // Ambient leans on upward-facing surfaces so ledges read without a sun.
  float sky = 0.62 + 0.38 * max(N.y, 0.0);
  vec3 lit = v_color * u_ambient * sky * u_ambientTint;

  // Headlamp. Wrapped diffuse, because a hard terminator on a flat wall of
  // front faces leaves everything a few tiles out unlit.
  vec3 toLamp = u_lampPos - v_world;
  float d = length(toLamp);
  float atten = u_lampPower / (1.0 + 0.15 * d + 0.045 * d * d);
  float ndl = max((dot(N, toLamp / max(d, 1e-4)) + 0.28) / 1.28, 0.0);
  lit += v_color * u_lampColor * ndl * atten;

  lit += v_color * v_emissive;

  lit = lit / (1.0 + 0.42 * max(max(lit.r, lit.g), lit.b));   // gentle highlight roll-off

  float dist = length(v_world - u_eye);
  float fog = clamp((dist - u_fogNear) / max(u_fogFar - u_fogNear, 1e-3), 0.0, 1.0);
  outColor = vec4(mix(lit, u_fogColor, fog * 0.9), 1.0);
}`;

// Full-screen backdrop: sky above the surface line, rock haze below.
const SKY_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_yTop;
uniform float u_yBottom;
uniform float u_surfaceY;
uniform float u_time;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float y = mix(u_yBottom, u_yTop, v_uv.y);
  float above = y - u_surfaceY;
  vec3 col;
  if (above > 0.0) {
    float t = clamp(above / 26.0, 0.0, 1.0);
    col = mix(vec3(0.478, 0.365, 0.333), vec3(0.071, 0.125, 0.227), t);
    // Stars, fading out toward the horizon.
    vec2 cell = floor(v_uv * vec2(190.0, 110.0));
    float star = step(0.994, hash(cell));
    float tw = 0.55 + 0.45 * sin(u_time * 2.2 + hash(cell) * 40.0);
    col += star * tw * t * vec3(0.85, 0.9, 1.0);
  } else {
    col = vec3(0.035, 0.031, 0.055);
  }
  outColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ meshes */

function boxMesh() {
  const faces = [
    { n: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },
    { n: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },
  ];
  const pos = [], nrm = [], idxs = [];
  faces.forEach((f, fi) => {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [su, sv] of corners) {
      for (let k = 0; k < 3; k++) {
        pos.push(f.n[k] * 0.5 + f.u[k] * 0.5 * su + f.v[k] * 0.5 * sv);
      }
      nrm.push(f.n[0], f.n[1], f.n[2]);
    }
    const b = fi * 4;
    idxs.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idxs) };
}

// Apex down (-Y), base at +Y: the drill bit.
function coneMesh(segments = 12) {
  const pos = [], nrm = [], idxs = [];
  const apex = [0, -0.5, 0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = [Math.cos(a0) * 0.5, 0.5, Math.sin(a0) * 0.5];
    const p1 = [Math.cos(a1) * 0.5, 0.5, Math.sin(a1) * 0.5];
    const ex = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const ey = [apex[0] - p0[0], apex[1] - p0[1], apex[2] - p0[2]];
    const n = [
      ex[1] * ey[2] - ex[2] * ey[1],
      ex[2] * ey[0] - ex[0] * ey[2],
      ex[0] * ey[1] - ex[1] * ey[0],
    ];
    const len = Math.hypot(...n) || 1;
    const b = pos.length / 3;
    for (const p of [p0, p1, apex]) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(n[0] / len, n[1] / len, n[2] / len);
    }
    idxs.push(b, b + 1, b + 2);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idxs) };
}

// Flat-shaded octahedron: ore crystals.
function gemMesh() {
  const v = [[0, 0.5, 0], [0, -0.5, 0], [0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5]];
  const tris = [
    [0, 4, 2], [0, 2, 5], [0, 5, 3], [0, 3, 4],
    [1, 2, 4], [1, 5, 2], [1, 3, 5], [1, 4, 3],
  ];
  const pos = [], nrm = [], idxs = [];
  tris.forEach((t, i) => {
    const [a, b, c] = t.map((k) => v[k]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(...n) || 1;
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(n[0] / len, n[1] / len, n[2] / len);
    }
    idxs.push(i * 3, i * 3 + 1, i * 3 + 2);
  });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idxs) };
}

/* ---------------------------------------------------------------- palettes */

const hexCache = new Map();
function hex(h) {
  let c = hexCache.get(h);
  if (!c) {
    c = [
      parseInt(h.slice(1, 3), 16) / 255,
      parseInt(h.slice(3, 5), 16) / 255,
      parseInt(h.slice(5, 7), 16) / 255,
    ];
    hexCache.set(h, c);
  }
  return c;
}

// Lit palettes. These run brighter than the 2D renderer's flat colours,
// because diffuse shading and distance fog both take a bite out of them.
const ROCK = {
  [T.DIRT]:      ['#7d5936', '#8d653e', '#6b4b2e'].map(hex),
  [T.ROCK]:      ['#6b6b76', '#787883', '#5d5d68'].map(hex),
  [T.DENSE]:     ['#565c6d', '#616879', '#4a5060'].map(hex),
  [T.OBSIDIAN]:  ['#464459', '#524f68', '#3a394b'].map(hex),
  [T.MAGMA]:     ['#5e373e', '#6d4048', '#4d2c32'].map(hex),
  [T.CORESHELL]: ['#66416f', '#764c80', '#573763'].map(hex),
  [T.BEDROCK]:   ['#1d1d24', '#24242c', '#17171d'].map(hex),
  [T.GAS]:       ['#526a3f', '#5e7a49', '#455a35'].map(hex),
  [T.CORE]:      ['#c07dff', '#e0aaff', '#9d5bd6'].map(hex),
};
const UNSEEN = hex('#1a1822');
const BACKDROP = hex('#100e17');
const oreColorCache = new Map();

function oreColors(ore) {
  let c = oreColorCache.get(ore.key);
  if (!c) { c = { body: hex(ore.color), glow: hex(ore.glow) }; oreColorCache.set(ore.key, c); }
  return c;
}

function hash2(x, y) {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

/* --------------------------------------------------------------- gl set-up */

const STRIDE = 11;             // offset3 + scale3 + color3 + emissive + rotY

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`${label} shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, `${label} vertex`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${label} fragment`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label} link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function makeBatch(gl, prog, mesh, capacity) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const nrmBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.STATIC_DRAW);
  const aNrm = gl.getAttribLocation(prog, 'a_normal');
  gl.enableVertexAttribArray(aNrm);
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);

  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);

  const instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, capacity * STRIDE * 4, gl.DYNAMIC_DRAW);
  const bytes = STRIDE * 4;
  const layout = [['i_offset', 3, 0], ['i_scale', 3, 12], ['i_color', 3, 24], ['i_extra', 2, 36]];
  for (const [name, size, off] of layout) {
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, off);
    gl.vertexAttribDivisor(loc, 1);
  }

  gl.bindVertexArray(null);
  return { vao, instBuf, count: mesh.idx.length, data: new Float32Array(capacity * STRIDE), n: 0 };
}

/* ---------------------------------------------------------------- renderer */

export function createRenderer3D(gl) {
  const blockProg = program(gl, BLOCK_VS, BLOCK_FS, 'block');
  const skyProg = program(gl, SKY_VS, SKY_FS, 'sky');

  const batches = {
    box: makeBatch(gl, blockProg, boxMesh(), 9000),
    gem: makeBatch(gl, blockProg, gemMesh(), 1200),
    cone: makeBatch(gl, blockProg, coneMesh(), 8),
  };

  const U = {};
  for (const name of ['u_viewProj', 'u_lampPos', 'u_lampColor', 'u_lampPower', 'u_ambient',
    'u_ambientTint', 'u_fogColor', 'u_eye', 'u_fogNear', 'u_fogFar']) {
    U[name] = gl.getUniformLocation(blockProg, name);
  }
  const SU = {};
  for (const name of ['u_yTop', 'u_yBottom', 'u_surfaceY', 'u_time']) {
    SU[name] = gl.getUniformLocation(skyProg, name);
  }

  const skyVao = gl.createVertexArray();
  const lastView = { w: 1, h: 1 };
  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  const viewProj = new Float32Array(16);

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  function reset() { for (const b of Object.values(batches)) b.n = 0; }

  function push(batch, x, y, z, sx, sy, sz, col, emissive = 0, rotY = 0) {
    const i = batch.n * STRIDE;
    if (i + STRIDE > batch.data.length) return;      // frame is already full
    const d = batch.data;
    d[i] = x; d[i + 1] = y; d[i + 2] = z;
    d[i + 3] = sx; d[i + 4] = sy; d[i + 5] = sz;
    d[i + 6] = col[0]; d[i + 7] = col[1]; d[i + 8] = col[2];
    d[i + 9] = emissive; d[i + 10] = rotY;
    batch.n++;
  }

  // Mirrors the 2D renderer's framing so the two backends feel the same.
  function tilesTall(cssW, cssH) {
    const zoom = Math.max(0.62, Math.min(2.3,
      Math.min(cssW / (21 * TILE), cssH / (14 * TILE))));
    return cssH / (TILE * zoom);
  }

  function render(state, cssW, cssH, dpr) {
    const p = state.player;
    const c = playerCenter(p);
    const px = c.x / TILE;
    const py = -c.y / TILE;
    const surfaceY = -SURFACE_ROW;

    const aspect = Math.max(0.2, cssW / cssH);
    const visH = tilesTall(cssW, cssH);
    const visW = visH * aspect;
    const dist = (visH / 2) / Math.tan(FOV / 2);

    // Keep the whole world in frame the way the 2D camera did.
    let camX = Math.max(visW / 2, Math.min(px, WORLD_W - visW / 2));
    if (visW >= WORLD_W) camX = WORLD_W / 2;
    let camY = Math.min(py, -SURFACE_ROW + visH * 0.35);
    camY = Math.max(camY, -(WORLD_H) + visH / 2);

    let shakeX = 0, shakeY = 0;
    if (state.shake > 0.05) {
      shakeX = (Math.random() - 0.5) * state.shake * 0.03;
      shakeY = (Math.random() - 0.5) * state.shake * 0.03;
    }

    const eye = [camX + shakeX, camY + 1.9 + shakeY, dist];
    const target = [camX + shakeX, camY + shakeY, 0];
    perspective(proj, FOV, aspect, 0.4, dist + 60);
    lookAt(view, eye, target, [0, 1, 0]);
    multiply(viewProj, proj, view);

    lastView.w = cssW; lastView.h = cssH;
    gl.viewport(0, 0, Math.round(cssW * dpr), Math.round(cssH * dpr));
    gl.clearColor(BACKDROP[0], BACKDROP[1], BACKDROP[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // ---- backdrop
    gl.useProgram(skyProg);
    gl.bindVertexArray(skyVao);
    gl.disable(gl.DEPTH_TEST);
    gl.uniform1f(SU.u_yTop, camY + visH / 2);
    gl.uniform1f(SU.u_yBottom, camY - visH / 2);
    gl.uniform1f(SU.u_surfaceY, surfaceY);
    gl.uniform1f(SU.u_time, state.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);

    // ---- scene
    reset();
    buildScene(state, camX, camY, visW, visH, surfaceY);

    const depth = state.depth;
    const ambient = 0.88 - 0.62 * Math.min(1, Math.max(0, (depth - 8) / 95));
    const lampPower = 2.15 + scanOf(state.upgrades) * 0.045;

    gl.useProgram(blockProg);
    gl.uniformMatrix4fv(U.u_viewProj, false, viewProj);
    gl.uniform3f(U.u_lampPos, c.x / TILE, -c.y / TILE, RIG_Z + 3.1);
    gl.uniform3f(U.u_lampColor, 1.0, 0.93, 0.78);
    gl.uniform1f(U.u_lampPower, lampPower);
    gl.uniform1f(U.u_ambient, ambient);
    const tint = depth > 190 ? [1.0, 0.86, 0.86] : [0.92, 0.94, 1.0];
    gl.uniform3f(U.u_ambientTint, tint[0], tint[1], tint[2]);
    gl.uniform3f(U.u_fogColor, BACKDROP[0], BACKDROP[1], BACKDROP[2]);
    gl.uniform3f(U.u_eye, eye[0], eye[1], eye[2]);
    gl.uniform1f(U.u_fogNear, dist * 0.75);
    gl.uniform1f(U.u_fogFar, dist * 2.1);

    for (const b of Object.values(batches)) {
      if (!b.n) continue;
      gl.bindVertexArray(b.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * STRIDE);
      gl.drawElementsInstanced(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0, b.n);
    }
    gl.bindVertexArray(null);
  }

  function buildScene(state, camX, camY, visW, visH, surfaceY) {
    const world = state.world;
    const box = batches.box;

    const x0 = Math.max(0, Math.floor(camX - visW / 2) - 2);
    const x1 = Math.min(WORLD_W - 1, Math.ceil(camX + visW / 2) + 2);
    const yTop = Math.max(0, Math.floor(-(camY + visH / 2)) - 2);
    const yBot = Math.min(WORLD_H - 1, Math.ceil(-(camY - visH / 2)) + 2);

    // Slab of rock behind every corridor, so a tunnel has a back to it.
    const wallTop = Math.min(surfaceY, camY + visH / 2);
    const wallBot = camY - visH / 2 - 1;
    if (wallTop > wallBot) {
      push(box, camX, (wallTop + wallBot) / 2, BACKDROP_Z - 0.2,
        visW + 6, wallTop - wallBot, 0.4, BACKDROP);
    }

    const dig = state.dig;
    for (let ty = yTop; ty <= yBot; ty++) {
      const wy = -(ty + 0.5);
      for (let tx = x0; tx <= x1; tx++) {
        const i = idx(tx, ty);
        const t = world.tiles[i];
        const wx = tx + 0.5;

        if (!world.seen[i]) {
          if (ty >= SURFACE_ROW) push(box, wx, wy, BLOCK_CZ, 1, 1, BLOCK_DEPTH, UNSEEN);
          continue;
        }
        if (t === T.EMPTY) continue;

        if (t === T.LAVA) {
          const wob = 0.5 + 0.5 * Math.sin(state.time * 2.4 + tx * 0.7 + ty * 0.3);
          push(box, wx, wy - 0.12, BLOCK_CZ + 0.05, 1, 0.78, BLOCK_DEPTH - 0.2,
            [0.92, 0.30 + wob * 0.16, 0.07], 0.55 + wob * 0.25);
          continue;
        }

        const h = hash2(tx, ty);
        const pal = ROCK[t] || ROCK[T.ROCK];
        const base = pal[h % 3];

        // The tile under the drill shrinks back into the wall as it gives way.
        let s = 1, sz = BLOCK_DEPTH, cz = BLOCK_CZ, em = 0;
        if (dig.x === tx && dig.y === ty && dig.progress > 0) {
          const k = Math.min(1, dig.progress);
          s = 1 - 0.30 * k;
          sz = BLOCK_DEPTH * (1 - 0.42 * k);
          cz = BLOCK_FRONT - sz / 2 - 0.42 * k;
          em = 0.10 * k;
        }

        if (t === T.CORE) {
          const pulse = 0.5 + 0.5 * Math.sin(state.time * 4 + tx);
          push(box, wx, wy, cz, s, s, sz, base, 0.55 + pulse * 0.5);
          continue;
        }
        if (t === T.GAS) {
          const pulse = 0.5 + 0.5 * Math.sin(state.time * 3.4 + tx * 1.7);
          push(box, wx, wy, cz, s, s, sz, base, em);
          push(batches.gem, wx, wy, BLOCK_FRONT - 0.18, 0.62, 0.62, 0.62,
            [0.62, 1.0, 0.42], 0.45 + pulse * 0.35, state.time * 1.1);
          continue;
        }

        push(box, wx, wy, cz, s, s, sz, base, em);

        if (isOre(t)) {
          const ore = oreOf(t);
          const col = oreColors(ore);
          const pulse = 0.5 + 0.5 * Math.sin(state.time * 1.9 + (h % 100));
          const size = (0.34 + (h % 3) * 0.05) * s;
          push(batches.gem, wx, wy, BLOCK_FRONT - 0.10 - (BLOCK_DEPTH - sz) * 0.5,
            size, size * 1.35, size, col.body, 0.22 + pulse * 0.22,
            state.time * 0.55 + (h % 10));
        }
      }
    }

    buildBase(state, surfaceY);
    buildRig(state);
    buildFx(state);
  }

  function buildBase(state, surfaceY) {
    const box = batches.box;
    for (const pad of PADS) {
      const x = pad.x + 0.5;
      const col = hex(pad.color);
      const near = state.nearPad && state.nearPad.key === pad.key;
      push(box, x, surfaceY + 0.75, 0.1, 2.4, 1.5, 1.6, [0.105, 0.115, 0.15]);
      push(box, x, surfaceY + 1.58, 0.1, 2.6, 0.18, 1.75, col, near ? 0.75 : 0.32);
      push(box, x, surfaceY + 0.45, 0.95, 1.1, 0.9, 0.1, [0.02, 0.02, 0.03]);
      push(box, x, surfaceY + 1.95, 0.1, 0.16, 0.62, 0.16, col, near ? 0.9 : 0.35);
    }
    // Ground line across the whole field.
    push(box, WORLD_W / 2, surfaceY + 0.04, BLOCK_FRONT - 0.02,
      WORLD_W, 0.08, 0.12, [0.23, 0.19, 0.13]);
  }

  function buildRig(state) {
    const p = state.player;
    const box = batches.box;
    const w = PHYS.playerW / TILE, h = PHYS.playerH / TILE;
    const x = p.x / TILE + w / 2;
    const y = -(p.y / TILE + h / 2);

    if (p.thrusting) {
      const f = 0.35 + Math.random() * 0.4;
      push(box, x, y - h / 2 - f / 2, RIG_Z, w * 0.55, f, 0.4,
        [1.0, 0.72, 0.28], 1.5);
    }

    push(box, x, y, RIG_Z, w, h * 0.82, 0.78, [0.878, 0.639, 0.235]);           // hull
    push(box, x, y - h * 0.44, RIG_Z, w * 0.92, h * 0.22, 0.72, [0.753, 0.498, 0.133]);
    push(box, x + (p.facing > 0 ? 0.11 : -0.11), y + h * 0.20, RIG_Z + 0.42,
      w * 0.42, h * 0.32, 0.1, [0.561, 0.847, 1.0], 0.35);                       // canopy
    push(box, x - w * 0.62, y, RIG_Z, 0.1, h * 0.7, 0.6, [0.16, 0.18, 0.23]);    // tracks
    push(box, x + w * 0.62, y, RIG_Z, 0.1, h * 0.7, 0.6, [0.16, 0.18, 0.23]);

    push(batches.cone, x, y - h * 0.62, RIG_Z, 0.42, 0.5, 0.42,
      [0.81, 0.84, 0.88], p.drilling ? 0.12 : 0.02, p.drillSpin);

    if (state.stranded) {
      const b = 0.4 + 0.6 * Math.abs(Math.sin(state.time * 6));
      push(box, x, y + h * 0.62, RIG_Z, 0.14, 0.14, 0.14, [1, 0.28, 0.28], b * 2.2);
    }
  }

  function buildFx(state) {
    const box = batches.box;
    for (const f of state.fx) {
      if (f.text) continue;                     // floating labels stay 2D, in the HUD
      const life = (f.until - state.time) / Math.max(0.001, f.until - f.born);
      const s = Math.max(0.04, (f.r / TILE) * 1.9 * Math.max(0, Math.min(1, life)));
      const col = typeof f.color === 'string' ? hex(f.color) : f.color;
      push(box, f.x / TILE, -f.y / TILE, RIG_Z + 0.3, s, s, s, col, 1.1);
    }
  }

  // World point -> CSS pixels, using the matrix from the frame just drawn.
  function project(wx, wy, wz) {
    const m = viewProj;
    const cx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
    const cy = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
    const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
    if (cw <= 0.001) return null;
    return {
      x: (cx / cw * 0.5 + 0.5) * lastView.w,
      y: (0.5 - cy / cw * 0.5) * lastView.h,
    };
  }

  return { render, project, mode: '3d' };
}
