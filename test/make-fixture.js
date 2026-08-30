// Synthesises WAVs of drum lug taps at known pitches. These are fed to Chromium
// as a fake microphone so the detector can be tested end to end.
const fs = require('fs');
const path = require('path');

const SR = 48000;

// Decaying tone built from partials, roughly how a drum tap reads. `tau` is
// the decay time constant: ~0.18 s for a damped head, ~0.6 s for a tom left to
// ring. Each partial is {r: frequency ratio, a: amplitude, tau: its own decay};
// `glide` starts the pitch sharp by that fraction and lets it settle, the way a
// freshly struck head does.
const LUG_PARTIALS = [
  { r: 1.00, a: 1.00 },
  { r: 1.59, a: 0.35 },
  { r: 2.14, a: 0.20 },
];

function tap(hz, seconds, { amp = 0.55, tau = 0.18, partials = LUG_PARTIALS, glide = 0 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const norm = partials.reduce((sum, p) => sum + p.a, 0);
  for (const p of partials) {
    const ptau = p.tau || tau;
    let phase = Math.random() * 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = hz * p.r * (1 + glide * Math.exp(-t / 0.12));
      phase += 2 * Math.PI * f / SR;
      out[i] += (amp * p.a / norm) * Math.exp(-t / ptau) * Math.sin(phase);
    }
  }
  // 2 ms fade-in so the attack is not a click that smears the spectrum
  const fade = Math.round(0.002 * SR);
  for (let i = 0; i < fade && i < n; i++) out[i] *= i / fade;
  return out;
}

// Room noise that is NOT a drum hit. These are the things that were falsely
// registering as taps: someone talking, a stick set down on the rim, a chair
// scraping, an air-conditioning hum.
function voice(seconds, { amp = 0.16, f0 = 130 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // slow attack and a wobbling pitch: nothing like a stick transient
    const env = Math.min(1, t / 0.08) * Math.min(1, (seconds - t) / 0.12);
    const f = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 3.1 * t));
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t + h) / h;
    out[i] = amp * env * v;
  }
  return out;
}

function clatter(seconds, { amp = 0.34 } = {}) {
  // A stick dropped on the rim: sharp attack like a drum hit, but broadband
  // rather than tonal, so only the spectral test can reject it.
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.0015) * Math.exp(-t / 0.09);
    lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;
    out[i] = amp * env * lp;
  }
  return out;
}

function hum(seconds, { amp = 0.05, f0 = 60 } = {}) {
  // Mains hum: always there, fades up rather than starting like an event.
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.5);
    out[i] = amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.4 * Math.sin(2 * Math.PI * f0 * 2 * t));
  }
  return out;
}

function mix(buf, src, atSeconds) {
  const start = Math.round(atSeconds * SR);
  for (let i = 0; i < src.length && start + i < buf.length; i++) buf[start + i] += src[i];
}

function build(freqs, { lead = 1.2, gap = 1.6, tail = 4.0, noise = 0.0006, tau = 0.18,
                        glide = 0, perHitPartials = null } = {}) {
  const total = Math.round((lead + freqs.length * gap + tail) * SR);
  const buf = new Float32Array(total);
  for (let i = 0; i < total; i++) buf[i] = (Math.random() * 2 - 1) * noise;
  freqs.forEach((hz, k) => {
    const start = Math.round((lead + k * gap) * SR);
    const partials = perHitPartials ? perHitPartials[k % perHitPartials.length] : LUG_PARTIALS;
    const maxTau = partials.reduce((m, p) => Math.max(m, p.tau || tau), tau);
    const t = tap(hz, maxTau * 6, { tau, partials, glide });
    for (let i = 0; i < t.length && start + i < total; i++) buf[start + i] += t[i];
  });
  return buf;
}

function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const SCENARIOS = [
  {
    // A damped head, taps spaced out: the easy case.
    name: 'damped',
    file: path.join(__dirname, 'fixture-damped.wav'),
    // five lugs near 200 Hz plus one deliberately sharp lug, so the verdict
    // logic gets exercised too
    freqs: [200.0, 201.5, 199.0, 220.0, 200.5, 198.5],
    opts: { gap: 1.6, tau: 0.18 },
  },
  {
    // The room the app actually gets used in: talking, a stick dropped on the
    // rim, a chair scrape, a hum under everything. Only the six taps may
    // register. Anything else silently overwrites a lug and moves the user on.
    name: 'noisy',
    file: path.join(__dirname, 'fixture-noisy.wav'),
    freqs: [200.0, 201.5, 199.0, 220.0, 200.5, 198.5],
    opts: { gap: 1.9, tau: 0.18, noise: 0.004 },
    // seconds are relative to the start of the file; taps land at 1.2 + k*1.9
    interference: [
      { at: 0.30, kind: 'voice',   sec: 0.55 },
      { at: 2.25, kind: 'clatter', sec: 0.35 },
      { at: 4.10, kind: 'voice',   sec: 0.70 },
      { at: 6.05, kind: 'clatter', sec: 0.35 },
      { at: 7.95, kind: 'voice',   sec: 0.50 },
      { at: 9.85, kind: 'clatter', sec: 0.35 },
      { at: 0.00, kind: 'hum',     sec: 16.0 },
    ],
  },
  {
    // The user's own consistency test: the same spot in the middle of the drum,
    // hit six times. A centre hit rings at the fundamental plus a partial an
    // octave up, and which of the two is louder varies hit to hit (phone mics
    // also shave bass). Every hit must read the fundamental — the readings
    // flipping between 80 and 160 for identical hits is the failure this
    // scenario pins down. The slight pitch settle of a fresh hit is included.
    name: 'center',
    file: path.join(__dirname, 'fixture-center.wav'),
    freqs: [80.0, 80.0, 80.0, 80.0, 80.0, 80.0],
    opts: {
      gap: 1.6, tau: 0.5, tail: 4.0, glide: 0.02,
      perHitPartials: [
        [{ r: 1, a: 1.00, tau: 0.5 }, { r: 2.01, a: 0.55, tau: 0.3 }],  // fundamental wins
        [{ r: 1, a: 0.40, tau: 0.5 }, { r: 2.01, a: 1.00, tau: 0.3 }],  // partial wins big
        [{ r: 1, a: 0.80, tau: 0.5 }, { r: 2.01, a: 1.00, tau: 0.3 }],  // partial wins
        [{ r: 1, a: 0.25, tau: 0.5 }, { r: 2.01, a: 1.00, tau: 0.3 }],  // bass badly shaved
        [{ r: 1, a: 1.00, tau: 0.5 }, { r: 2.01, a: 0.90, tau: 0.3 }],  // near tie
        [{ r: 1, a: 0.55, tau: 0.5 }, { r: 2.01, a: 1.00, tau: 0.3 }],  // partial wins
      ],
    },
  },
  {
    // A tom left ringing, tapped briskly. The previous hit is still sounding
    // when the next one lands, and it rings on for seconds after the last lug.
    name: 'ringing',
    file: path.join(__dirname, 'fixture-ringing.wav'),
    freqs: [200.0, 230.0, 180.0, 215.0, 195.0, 240.0],
    opts: { gap: 0.8, tau: 0.6, tail: 4.0 },
  },
];

const NOISE_MAKERS = { voice, clatter, hum };

function generate() {
  for (const s of SCENARIOS) {
    const buf = build(s.freqs, s.opts);
    for (const n of s.interference || []) mix(buf, NOISE_MAKERS[n.kind](n.sec), n.at);
    writeWav(s.file, buf);
  }
}

if (require.main === module) {
  generate();
  for (const s of SCENARIOS) console.log('wrote', path.basename(s.file));
}

module.exports = { SR, SCENARIOS, tap, build, writeWav, generate };
