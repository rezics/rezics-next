import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { routeWebCheck } from './check-placement.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const routed = await routeWebCheck({
  root,
  cwd: app,
  command: ['bun', 'scripts/cards.ts', ...process.argv.slice(2)],
  returns: ['apps/web/public/cards'],
});
if (routed !== null) process.exit(routed);
const output = resolve(app, 'public/cards');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box } body { margin: 0; background: #f9f6f2; color: #2b343d; font-family: Arial, sans-serif }
    main { height: 630px; display: flex; align-items: center; padding: 100px 120px; gap: 115px;
      background: radial-gradient(ellipse at 13% 18%, #f8e6e2, transparent 56%), radial-gradient(ellipse at 88% 18%, #e2eaf6, transparent 60%) }
    .mark { width: 310px; height: 410px; background: #d9e4f1; border-radius: 12px; box-shadow: 0 16px 40px #2b343d20;
      display:flex; flex-direction:column; justify-content:space-between; padding: 32px; color: #1f4a85 }
    .mark span { font: 600 72px Georgia, serif } .mark i { width: 64px; height: 8px; background: #df3d35; border-radius: 5px }
    .wordmark { font-size: 82px; letter-spacing: .08em; font-weight: 800 } .rule { width: 68px; height: 8px; border-radius: 4px; background: #df3d35; margin-top: 22px }
  </style></head><body><main><div class="mark"><span>R</span><i></i></div><div><div class="wordmark">REZICS</div><div class="rule"></div></div></main></body></html>`);
  await page.screenshot({ path: resolve(output, 'default.png') });
} finally {
  await browser.close();
}
