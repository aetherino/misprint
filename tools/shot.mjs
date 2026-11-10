// Headless-Chrome screenshot + console capture for any page of the game.
//   node tools/shot.mjs <url> <out.png> [--wait 2500] [--size 1280x720] [--eval "js to run in page"] [--after 500] [--click x,y]
// Prints every console message and page error (so you can see runtime errors), then saves the PNG.
// WebGL runs on SwiftShader (software) here: expect ~5-15 fps. That is NOT representative of real GPUs.
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const url = args[0], out = args[1];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const [w, h] = opt('size', '1280x720').split('x').map(Number);

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(opt('wait', 2500)));
const click = opt('click', null);
if (click) { const [x, y] = click.split(',').map(Number); await page.mouse.click(x, y); }
const ev = opt('eval', null);
if (ev) {
  try { const r = await page.evaluate(ev); if (r !== undefined) console.log('[eval result]', JSON.stringify(r)); }
  catch (e) { console.log('[eval error]', e.message); }
  await page.waitForTimeout(Number(opt('after', 500)));
}
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
