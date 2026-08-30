# drum-tuner

A browser drum tuner. Tap the head next to each lug; it reads the pitch of every
lug, shows them on a drum diagram, and tells you which rods to tighten or loosen.

A drum is "in tune with itself" when every lug rings at the same pitch, so the
useful number is not the absolute frequency but the *spread* between lugs. The
app targets under 3% spread and names the lugs that are furthest off.

The whole app is one self-contained `index.html` — no build step, no
dependencies at runtime. Everything is analysed on-device; no audio leaves the
browser.

## Running it

The microphone needs a secure context, so `file://` will not work — serve it
over localhost (or any https host):

```sh
npm run serve      # http://127.0.0.1:8080
```

Any static host works for deployment, including GitHub Pages pointed at the
repository root.

### Testing on a phone

The microphone needs a secure context, and `http://` on a LAN address is not
one — a phone pointed at your laptop's IP will be refused mic access. Either
deploy to any https host, or tunnel the local server:

```sh
npm run serve
cloudflared tunnel --url http://localhost:8080   # or: ngrok http 8080
```

Then open the https URL the tunnel prints on the phone.

## How it measures

1. **Onset detection.** Each animation frame the RMS of the last 1024 samples is
   compared against a running background envelope, and a hit must be a sudden
   *jump* — 2.2x over the quieter of the two previous frames — not just a loud
   moment. A ringing head can't re-trigger, and sounds that swell (speech, a
   chair scrape) don't start a capture.
2. **The room is subtracted.** For the first 0.7 s after the mic opens the app
   learns the room's steady spectrum (mains hum, fans). After that each
   frequency bin tracks its own running minimum — dropping instantly to any new
   quiet, climbing only ~3 dB/s — so nothing that *sounds* can become part of
   the background. A peak only counts if its rise above the room stands 10 dB
   clear of the band's typical rise, which also rejects broadband clatter.
3. **Three looks down the decay.** The spectrum is read 150, 330 and 550 ms
   after the onset. A frequency counts only if all three looks contain it, never
   louder than the look before — a struck head only decays, while a noise bump
   is gone by the next look and a voice's pitch wobbles or swells. The looks are
   unevenly spaced so a periodic vibrato can't sync with them. Each look's peaks
   get parabolic interpolation for sub-bin accuracy.
4. **The fundamental wins.** Among the partials that survive, if the loudest one
   has a partner at half its frequency, the half is reported — so hitting the
   same spot gives the same number even when two partials trade loudness from
   hit to hit (phone mics shave bass, which otherwise decides that coin-flip).
5. **Verdict.** Lugs are compared against the *median* of the measured lugs, so
   one wildly loose rod doesn't drag the reference off, and the verdict says
   which way to turn each offending rod.

Once every lug has been read the detector disarms, so a stray hit can't
overwrite good readings. Select a lug on the diagram to re-measure it.

Batter and reso heads keep separate sets of readings, and readings are saved to
`localStorage` so closing the page doesn't lose your work.

## Tests

`test/e2e.js` drives the real app in Chromium with a synthesised WAV supplied as
a fake microphone, so onset detection, the FFT capture, the verdict logic and
persistence are all exercised end to end.

```sh
npm install        # playwright
npx playwright install chromium
npm test
```

Two fixtures are generated on demand (`npm run fixtures` to rebuild them):

| scenario  | decay  | tap spacing | what it covers |
|-----------|--------|-------------|----------------|
| `damped`  | τ 0.18 s | 1.6 s | accuracy, the "which lug is off" verdict, persistence, reset, batter/reso separation |
| `noisy`   | τ 0.18 s | 1.9 s | talking, a dropped stick, a chair scrape and a 60 Hz mains hum layered around the taps — exactly one reading per tap, none for the interference |
| `center`  | τ 0.5 s  | 1.6 s | six identical centre hits whose fundamental and octave partial trade loudness — every reading must be the fundamental, never an octave flip |
| `ringing` | τ 0.6 s  | 0.8 s | a tom left ringing: hits that overlap, and a long tail after the last lug that must not re-trigger |

The tests use Playwright's full `chromium` channel rather than the default
headless shell, which ships without a media-capture stack.
