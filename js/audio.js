// Tiny WebAudio synth — no asset files, so the whole game is text.
// The context is created on the first user gesture, as browsers require.

let ctx = null;
let master = null;
let noiseBuf = null;
let thrustSrc = null, thrustGain = null;
let enabled = true;
let lastDig = 0;

export function isEnabled() { return enabled; }

export function setEnabled(on) {
  enabled = on;
  if (master) master.gain.value = on ? 0.55 : 0;
  return enabled;
}

export function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = enabled ? 0.55 : 0;
  master.connect(ctx.destination);

  const len = Math.floor(ctx.sampleRate * 1.2);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function tone(freq, dur, type = 'square', gain = 0.25, slideTo = null) {
  if (!ctx || !enabled) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
  g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g); g.connect(master);
  o.start(); o.stop(ctx.currentTime + dur + 0.02);
}

function noise(dur, freq, q, gain = 0.3) {
  if (!ctx || !enabled || !noiseBuf) return;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(); s.stop(ctx.currentTime + dur);
}

export function setThrust(on) {
  if (!ctx || !enabled) return;
  if (on && !thrustSrc) {
    thrustSrc = ctx.createBufferSource();
    thrustSrc.buffer = noiseBuf;
    thrustSrc.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 620;
    thrustGain = ctx.createGain();
    thrustGain.gain.value = 0;
    thrustSrc.connect(f); f.connect(thrustGain); thrustGain.connect(master);
    thrustSrc.start();
  }
  if (thrustGain) {
    thrustGain.gain.setTargetAtTime(on ? 0.1 : 0, ctx.currentTime, 0.05);
  }
  if (!on && thrustSrc) {
    const s = thrustSrc;
    thrustSrc = null;
    setTimeout(() => { try { s.stop(); } catch (_) { /* already stopped */ } }, 260);
  }
}

export function sfx(kind) {
  if (!ctx || !enabled) return;
  switch (kind) {
    case 'dig': {
      const now = ctx.currentTime;
      if (now - lastDig < 0.055) return;          // the drill ticks, it does not roar
      lastDig = now;
      noise(0.05, 900 + Math.random() * 500, 1.6, 0.13);
      break;
    }
    case 'break':   noise(0.14, 380, 1.1, 0.24); break;
    case 'ore':     tone(660, 0.1, 'square', 0.18); tone(990, 0.13, 'square', 0.14, 1320); break;
    case 'gem':     tone(880, 0.12, 'triangle', 0.22); tone(1320, 0.2, 'triangle', 0.18, 1760); break;
    case 'sell':    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'triangle', 0.2), i * 55)); break;
    case 'buy':     tone(440, 0.09, 'square', 0.2); tone(660, 0.12, 'square', 0.16); break;
    case 'deny':    tone(180, 0.16, 'sawtooth', 0.16, 110); break;
    case 'hurt':    noise(0.22, 180, 0.8, 0.3); tone(140, 0.2, 'sawtooth', 0.16, 70); break;
    case 'explode': noise(0.7, 120, 0.5, 0.45); tone(90, 0.5, 'sawtooth', 0.22, 40); break;
    case 'wreck':   [330, 262, 196, 147].forEach((f, i) => setTimeout(() => tone(f, 0.28, 'sawtooth', 0.2), i * 110)); break;
    case 'win':     [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => setTimeout(() => tone(f, 0.4, 'triangle', 0.22), i * 130)); break;
    case 'click':   tone(1200, 0.04, 'square', 0.1); break;
    default: break;
  }
}
