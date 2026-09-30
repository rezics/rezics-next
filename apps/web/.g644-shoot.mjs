import { chromium } from 'playwright';
const [,, url, name, locale = 'en'] = process.argv;
const browser = await chromium.launch();
for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, locale });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  console.log(label, page.url(), await page.title(), await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.screenshot({ path: `../../.temp/shots/${name}-${label}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
