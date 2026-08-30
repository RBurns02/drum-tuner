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

1. **Onset detection.** Each animation frame the RMS of the last 2048 samples is
   compared against a running background envelope. A hit is a *rise* over that
   background, not just a loud moment — a fixed threshold would keep
   re-triggering while the head is still ringing.
2. **Capture.** 170 ms after the onset the analyser's ~340 ms FFT window is
   read, which skips the broadband attack transient and lands on the modal ring.
   The lockout between accepted hits is longer than that window, so a previous
   tap cannot bleed into the next reading.
3. **Pitch.** The strongest bin between 40 and 700 Hz wins, refined by parabolic
   interpolation across its neighbours for sub-bin accuracy. The peak has to
   stand at least 10 dB above the band's median or the hit is rejected as
   pitchless, and the user is told why.
4. **Verdict.** Lugs are compared against the *median* of the measured lugs, so
   one wildly loose rod doesn't drag the reference off.

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
| `ringing` | τ 0.6 s  | 0.8 s | a tom left ringing: hits that overlap, and a long tail after the last lug that must not re-trigger |

The tests use Playwright's full `chromium` channel rather than the default
headless shell, which ships without a media-capture stack.
