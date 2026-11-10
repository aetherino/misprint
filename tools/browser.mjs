// Headless browser for the dev/test tools. Needs Playwright: `npm i -D playwright && npx playwright install chromium`.
// Override with PLAYWRIGHT_DIR (a node_modules dir that contains playwright) and CHROME_PATH (a Chrome binary).
import fs from 'node:fs';
import { createRequire } from 'node:module';

async function loadPlaywright() {
  const dirs = [process.env.PLAYWRIGHT_DIR, '/opt/npm-tools/node_modules/'].filter(Boolean);
  try { return await import('playwright'); } catch { /* fall through to known locations */ }
  for (const dir of dirs) {
    try { return createRequire(dir.endsWith('/') ? dir : dir + '/')('playwright'); } catch { /* next */ }
  }
  throw new Error('Playwright not found. Run: npm i -D playwright && npx playwright install chromium');
}

const { chromium } = await loadPlaywright();
export { chromium };

const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));

// Software WebGL (SwiftShader) so screenshots work on machines without a GPU.
export function launchBrowser(extraArgs = []) {
  return chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio', ...extraArgs],
  });
}
