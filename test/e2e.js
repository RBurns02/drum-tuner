// End-to-end check of the tuner. Chromium is given a synthesised WAV as its
// microphone, so this exercises onset detection, the FFT capture, the verdict
// logic and persistence exactly as they run on a phone.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { SCENARIOS, generate } = require('./make-fixture');

const ROOT = path.join(__dirname, '..');
const TOLERANCE_HZ = 2.0;
const LAUNCH_ARGS = [
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Keeps the run hermetic: the page's webfont link must not reach the network.
async function openPage(browser, port) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  const accepted = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.exposeFunction('__reading', hz => accepted.push(hz));
  await page.route('**/*', r =>
    new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.goto(`http://127.0.0.1:${port}/`);
  // Count every reading the app accepts, so a hit invented from room noise is
  // caught even when it lands on a lug that a later real tap overwrites.
  await page.evaluate(() => {
    const hz = document.getElementById('hzOut');
    new MutationObserver(() => window.__reading(hz.textContent.trim()))
      .observe(hz, { childList: true, subtree: true, characterData: true });
  });
  return { page, errors, accepted };
}

const storedTaps = () => {
  const raw = localStorage.getItem('drumtuner.v1');
  return raw ? (JSON.parse(raw).sets || {}).batter || [] : [];
};

async function runScenario(scenario, port) {
  console.log(`\n[${scenario.name}] ${scenario.freqs.length} lugs, ` +
              `${scenario.opts.gap}s apart, decay tau=${scenario.opts.tau}s`);
  const browser = await chromium.launch({
    // The headless shell ships without a media-capture stack; the full build has one.
    channel: 'chromium',
    args: [...LAUNCH_ARGS, `--use-file-for-fake-audio-capture=${scenario.file}%noloop`],
  });

  try {
    const { page, errors, accepted } = await openPage(browser, port);

    await page.click(`#lugSeg button[aria-label="${scenario.freqs.length} lugs"]`);
    await page.click('#startBtn');
    check('mic explainer shown before access is requested', await page.isVisible('#micModal .modal'));
    await page.click('#micAllow');
    await page.waitForFunction(
      () => document.getElementById('statusTxt').textContent === 'listening',
      null, { timeout: 5000 });

    // Let the whole fixture play, including the tail after the last lug.
    await page.waitForTimeout(
      (1.2 + scenario.freqs.length * scenario.opts.gap + (scenario.opts.tail || 4) + 1) * 1000);

    const taps = await page.evaluate(storedTaps);
    console.log('    measured', taps.map(v => (v == null ? '--' : v.toFixed(2))).join(', '));
    console.log('    expected', scenario.freqs.map(v => v.toFixed(2)).join(', '));

    const worst = scenario.freqs.reduce((m, want, i) =>
      Math.max(m, typeof taps[i] === 'number' ? Math.abs(taps[i] - want) : Infinity), 0);
    check(`every lug read within ${TOLERANCE_HZ} Hz`, worst <= TOLERANCE_HZ,
      isFinite(worst) ? `worst ${worst.toFixed(2)} Hz` : 'a lug never read');

    // One reading per tap: no phantom hits, and none of the real taps dropped.
    check('one reading per tap, no more and no fewer',
      accepted.length === scenario.freqs.length,
      `${accepted.length} readings for ${scenario.freqs.length} taps`);

    if (scenario.name === 'noisy') {
      check('talking, clatter and a mains hum never register as taps',
        accepted.length === scenario.freqs.length && worst <= TOLERANCE_HZ);
    }

    if (scenario.name === 'ringing') {
      // The last tap rings for seconds after the drum is fully measured; those
      // must not re-trigger and overwrite readings.
      check('a ringing head does not re-trigger once every lug is read',
        taps.every((v, i) => typeof v === 'number' &&
                   Math.abs(v - scenario.freqs[i]) <= TOLERANCE_HZ));
    }

    if (scenario.name === 'damped') {
      const verdict = await page.textContent('#verdict');
      check('verdict names the out-of-tune lug', /Lug 4\b/.test(verdict) && /loosen/.test(verdict),
        verdict.replace(/\s+/g, ' ').trim().slice(0, 96));
      check('verdict leaves the in-tune lugs alone', !/Lug [12356]\b/.test(verdict));

      await page.click('#startBtn');
      await page.reload();
      const after = await page.evaluate(storedTaps);
      check('readings survive a reload',
        after.length === taps.length &&
        after.every((v, i) => typeof v === 'number' && Math.abs(v - taps[i]) < 1e-6));
      check('saved readings are redrawn on the diagram',
        (await page.locator('#drum text').count()) >= scenario.freqs.length * 2);

      check('the two heads keep separate readings', await (async () => {
        await page.click('#sideSeg button:nth-child(2)');            // reso
        const reso = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('drumtuner.v1')).sets.reso);
        await page.click('#sideSeg button:nth-child(1)');            // back to batter
        const batter = await page.evaluate(storedTaps);
        return reso.every(v => v === null) && batter.every(v => typeof v === 'number');
      })());

      await page.click('#resetBtn');
      check('reset clears both heads', await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('drumtuner.v1')).sets;
        return s.batter.every(v => v === null) && s.reso.every(v => v === null);
      }));
    }

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }
}

(async () => {
  if (!SCENARIOS.every(s => fs.existsSync(s.file))) generate();
  const { server, port } = await serve();
  try {
    for (const s of SCENARIOS) await runScenario(s, port);
  } finally {
    server.close();
  }
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
