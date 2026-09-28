// Measures the page types of a running production web build and prints a
// Markdown table of medians, optionally writing the samples as JSON:
//
//   node apps/web/tests/perf-report.ts --base http://127.0.0.1:3003 --work <uuid> \
//     --chapter <uuid> --profile <handle> [--realm fiction] [--author <email>:<password>] \
//     [--runs 3] [--only home,reader] [--json .temp/perf/after.json]
//
// Build and serve with `task web:preview` (QA stack) or `vinext build` and
// `wrangler dev --config dist/server/wrangler.json` against the shared backend.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { startPerfEdge } from './perf-edge.ts';
import { formatSamples, measure, perfProfiles, type PerfSample, type PerfTarget } from './perf-measure.ts';
import { signIn } from './perf-targets.ts';

const { values } = parseArgs({ options: { base: { type: 'string' }, work: { type: 'string' },
  chapter: { type: 'string' }, profile: { type: 'string' }, realm: { type: 'string', default: 'fiction' },
  author: { type: 'string' }, runs: { type: 'string', default: '3' }, only: { type: 'string' },
  json: { type: 'string' } } });
if (!values.base || !values.work || !values.chapter || !values.profile) {
  throw new Error('--base, --work, --chapter and --profile are required');
}

/** One keystroke into the header search, which every page has. */
const typeSearch = async (page: Page) => {
  const field = page.getByRole('search').first().locator('input');
  await field.click();
  await page.keyboard.type('the', { delay: 120 });
};

const targets: PerfTarget[] = [
  { name: 'home', path: '/en', interact: typeSearch },
  { name: 'discover', path: '/en/discover', interact: typeSearch },
  { name: 'search', path: '/en/search?q=tide', interact: typeSearch },
  { name: 'work', path: `/en/w/${values.work}`, interact: typeSearch },
  { name: 'reader', path: `/en/w/${values.work}/read/${values.chapter}`, interact: typeSearch },
  { name: 'realm', path: `/en/r/${values.realm}`, interact: typeSearch },
  { name: 'profile', path: `/en/@${values.profile}`, interact: typeSearch },
].filter(target => !values.only || values.only.split(',').includes(target.name));

const browser = await chromium.launch();
const edge = await startPerfEdge(values.base);
try {
  // Account rotates refresh tokens and revokes the session when a rotated one is reused, so every signed-in load
  // gets a session of its own rather than a shared copy of one.
  type State = Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>;
  let session: (() => Promise<State>) | undefined;
  if (values.author) {
    const [email, password] = [values.author.slice(0, values.author.indexOf(':')),
      values.author.slice(values.author.indexOf(':') + 1)];
    session = async () => {
      const context = await browser.newContext({ baseURL: values.base });
      try {
        await signIn(await context.newPage(), '/en', { email, password });
        return await context.storageState();
      } finally { await context.close(); }
    };
    // Studio redirects to the signed-in person's own desk; measure the desk, not the redirect.
    const context = await browser.newContext({ baseURL: values.base, storageState: await session() });
    const page = await context.newPage();
    await page.goto('/en/studio');
    await page.waitForURL(/\/studio\/@/);
    if (!values.only || values.only.split(',').includes('studio')) {
      targets.push({ name: 'studio', path: new URL(page.url()).pathname, interact: typeSearch });
    }
    await context.close();
  }
  const samples: PerfSample[] = [];
  for (const target of targets) {
    for (const profile of perfProfiles) {
      const runs: PerfSample[] = [];
      for (let run = 0; run < Number(values.runs); run += 1) {
        runs.push(await measure(browser, edge.origin, target, profile,
          target.name === 'studio' && session ? { storageState: await session() } : {}));
      }
      samples.push(median(runs));
      console.error(`${target.name} ${profile.name} done`);
    }
  }
  console.log(formatSamples(samples));
  if (values.json) writeFileSync(values.json, `${JSON.stringify(samples, null, 2)}\n`);
} finally {
  await browser.close();
  await edge.close();
}

/** The run with the median LCP, so each row is one coherent load. */
function median(runs: PerfSample[]): PerfSample {
  const sorted = runs.toSorted((a, b) => a.lcp - b.lcp);
  return sorted[Math.floor(sorted.length / 2)]!;
}
