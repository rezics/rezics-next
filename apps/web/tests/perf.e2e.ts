import { expect, test } from '@playwright/test';
import { type PerfEdge, startPerfEdge } from './perf-edge.ts';
import { measure, perfProfiles, type PerfSample } from './perf-measure.ts';
import { member, type PageTargets, pageTargets, signIn } from './perf-targets.ts';

// Performance budgets for the production build, loaded cold through a local
// edge (HTTP/2, streaming gzip) on a desktop and on Lighthouse's throttled
// phone. Vitals use Google's "good" thresholds where a lab run can hold them;
// transfer budgets sit a little above what each page needed on 2026-09-28, so
// a new heavy dependency or a leak of server code into the browser fails here.
// `node apps/web/tests/perf-report.ts` prints the same measurements as a table.

const upstream = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3003';

const vitals = {
  desktop: { lcp: 2_500, cls: 0.1, tbt: 200 },
  // Slow 4G adds 562 ms to every request, so the phone's LCP budget is the "needs improvement" edge.
  phone: { lcp: 4_000, cls: 0.1, tbt: 600 },
};

/** Compressed bytes the page itself needs (PerfSample.initial). */
const initial = { script: 300 * 1024, stylesheet: 40 * 1024, font: 110 * 1024, document: 64 * 1024 };

const pages: { name: string; path: (targets: PageTargets) => string; signedIn?: boolean }[] = [
  { name: 'home', path: () => '/en' },
  { name: 'discover', path: () => '/en/discover' },
  { name: 'search', path: () => '/en/search?q=tide' },
  { name: 'work', path: targets => `/en/w/${targets.work}` },
  { name: 'reader', path: targets => `/en/w/${targets.work}/read/${targets.chapter}` },
  { name: 'realm', path: targets => `/en/r/${targets.realm}` },
  { name: 'profile', path: targets => `/en/@${targets.profile}` },
  { name: 'studio', path: () => '/en/studio', signedIn: true },
];

let edge: PerfEdge;
let targets: PageTargets;
let session: string | undefined;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  targets = await pageTargets();
  edge = await startPerfEdge(upstream);
  const account = member();
  if (account) {
    // Sign in on the Worker itself; the session cookie is scoped to the host, so the edge carries it.
    const context = await browser.newContext({ baseURL: upstream });
    const page = await context.newPage();
    await signIn(page, '/en', account);
    session = JSON.stringify(await context.storageState());
    await context.close();
  }
});

test.afterAll(async () => { await edge?.close(); });

for (const entry of pages) {
  test(`${entry.name} loads within its budgets on desktop and phone`, async ({ browser }, info) => {
    test.setTimeout(120_000);
    test.skip(Boolean(entry.signedIn) && !session, 'No member to sign in');
    const samples: PerfSample[] = [];
    for (const profile of perfProfiles) {
      const sample = await measure(browser, edge.origin, { name: entry.name, path: entry.path(targets) }, profile,
        entry.signedIn ? { storageState: JSON.parse(session!) } : {});
      samples.push(sample);
      const budget = vitals[profile.name];
      const label = `${entry.name} on ${profile.name}`;
      expect.soft(sample.lcp, `${label}: LCP ms (${sample.lcpElement})`).toBeLessThanOrEqual(budget.lcp);
      expect.soft(sample.cls, `${label}: CLS (${JSON.stringify(sample.shifts)})`).toBeLessThanOrEqual(budget.cls);
      expect.soft(sample.tbt, `${label}: TBT ms`).toBeLessThanOrEqual(budget.tbt);
      for (const [kind, limit] of Object.entries(initial) as [keyof typeof initial, number][]) {
        expect.soft(sample.initial[kind], `${label}: ${kind} bytes the page needs`).toBeLessThanOrEqual(limit);
      }
    }
    await info.attach(`${entry.name}.json`, { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  });
}
