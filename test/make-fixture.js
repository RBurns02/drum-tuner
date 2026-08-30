// Synthesises WAVs of drum lug taps at known pitches. These are fed to Chromium
// as a fake microphone so the detector can be tested end to end.
const fs = require('fs');
const path = require('path');

const SR = 48000;

// Decaying tone with two inharmonic partials, roughly how a lug tap reads.
// `tau` is the decay time constant: ~0.18 s for a damped head, ~0.6 s for a
// tom left to ring.
function tap(hz, seconds, { amp = 0.55, tau = 0.18 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t / tau);
    out[i] = amp * env * (
      Math.sin(2 * Math.PI * hz * t) +
      0.35 * Math.sin(2 * Math.PI * 1.59 * hz * t + 0.7) +
      0.20 * Math.sin(2 * Math.PI * 2.14 * hz * t + 1.9)
    ) / 1.55;
  }
  // 2 ms fade-in so the attack is not a click that smears the spectrum
  const fade = Math.round(0.002 * SR);
  for (let i = 0; i < fade && i < n; i++) out[i] *= i / fade;
  return out;
}

function build(freqs, { lead = 1.2, gap = 1.6, tail = 4.0, noise = 0.0006, tau = 0.18 } = {}) {
  const total = Math.round((lead + freqs.length * gap + tail) * SR);
  const buf = new Float32Array(total);
  for (let i = 0; i < total; i++) buf[i] = (Math.random() * 2 - 1) * noise;
  freqs.forEach((hz, k) => {
    const start = Math.round((lead + k * gap) * SR);
    const t = tap(hz, tau * 6, { tau });
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
    // A tom left ringing, tapped briskly. The previous hit is still sounding
    // when the next one lands, and it rings on for seconds after the last lug.
    name: 'ringing',
    file: path.join(__dirname, 'fixture-ringing.wav'),
    freqs: [200.0, 230.0, 180.0, 215.0, 195.0, 240.0],
    opts: { gap: 0.8, tau: 0.6, tail: 4.0 },
  },
];

function generate() {
  for (const s of SCENARIOS) writeWav(s.file, build(s.freqs, s.opts));
}

if (require.main === module) {
  generate();
  for (const s of SCENARIOS) console.log('wrote', path.basename(s.file));
}

module.exports = { SR, SCENARIOS, tap, build, writeWav, generate };
