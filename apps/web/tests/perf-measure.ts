import type { Browser, BrowserContextOptions, CDPSession, Page } from '@playwright/test';

// Field-comparable lab measurements for the production web build. Metrics come
// from the browser's own PerformanceObserver entries, the same ones the
// web-vitals library reads; transfer comes from CDP's encoded (on-the-wire)
// byte counts, so it includes compression and headers.

/** A device and network profile. `phone` is Lighthouse's default mobile run:
 * a Moto G Power–sized screen, 4× CPU slowdown and Slow 4G as DevTools applies
 * it (562.5 ms request latency, 1.47 Mbps down, 675 kbps up). */
export interface PerfProfile {
  name: 'desktop' | 'phone';
  context: BrowserContextOptions;
  cpuSlowdown: number;
  network?: { latency: number; downloadThroughput: number; uploadThroughput: number };
}

export const perfProfiles: readonly PerfProfile[] = [
  { name: 'desktop', cpuSlowdown: 1,
    context: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1 } },
  { name: 'phone', cpuSlowdown: 4,
    context: { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/140.0.0.0 Mobile Safari/537.36' },
    network: { latency: 562.5, downloadThroughput: 1474.56 * 1024 / 8, uploadThroughput: 675 * 1024 / 8 } },
];

export type ResourceKind = 'document' | 'script' | 'stylesheet' | 'font' | 'image' | 'fetch' | 'other';

export interface PerfSample {
  page: string;
  profile: PerfProfile['name'];
  url: string;
  ttfb: number;
  fcp: number;
  lcp: number;
  /** What the largest contentful paint drew, for finding the cost behind it. */
  lcpElement: string;
  cls: number;
  /** The slowest interaction's input-to-next-paint time, when the page has a scripted interaction. */
  inp: number | null;
  /** Main-thread time beyond 50 ms per long task, from first paint until the page settled. */
  tbt: number;
  requests: number;
  transfer: Record<ResourceKind | 'total', number>;
}

/** A page to measure: an address and, optionally, one representative
 * interaction whose latency stands in for INP. */
export interface PerfTarget {
  name: string;
  path: string;
  interact?: (page: Page) => Promise<void>;
}

const observers = () => {
  const state = { lcp: 0, lcpElement: '', cls: 0, windowValue: 0, windowStart: 0, windowLast: 0,
    tbt: 0, fcp: 0, interactions: new Map<number, number>() };
  (globalThis as unknown as { __perf: typeof state }).__perf = state;
  const describe = (node: Element | null | undefined) => node
    ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.getAttribute('class')
      ? `.${node.getAttribute('class')!.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}` : '';
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as (PerformanceEntry & { element?: Element; url?: string })[]) {
      state.lcp = entry.startTime;
      state.lcpElement = `${describe(entry.element)}${entry.url ? ` ${entry.url}` : ''}`;
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  // CLS is the largest session window: shifts less than 1 s apart, at most 5 s long.
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (entry.hadRecentInput) continue;
      if (state.windowValue && entry.startTime - state.windowLast < 1_000 && entry.startTime - state.windowStart < 5_000) {
        state.windowValue += entry.value;
      } else {
        state.windowValue = entry.value;
        state.windowStart = entry.startTime;
      }
      state.windowLast = entry.startTime;
      state.cls = Math.max(state.cls, state.windowValue);
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') state.fcp = entry.startTime;
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (state.fcp && entry.startTime >= state.fcp) state.tbt += Math.max(0, entry.duration - 50);
    }
  }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as (PerformanceEntry & { interactionId?: number })[]) {
      if (!entry.interactionId) continue;
      state.interactions.set(entry.interactionId,
        Math.max(state.interactions.get(entry.interactionId) ?? 0, entry.duration));
    }
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
};

function kindOf(type: string | undefined): ResourceKind {
  switch (type) {
    case 'Document': return 'document';
    case 'Script': return 'script';
    case 'Stylesheet': return 'stylesheet';
    case 'Font': return 'font';
    case 'Image': return 'image';
    case 'Fetch': case 'XHR': return 'fetch';
    default: return 'other';
  }
}

async function settle(page: Page, quietMs: number, limitMs: number) {
  await page.waitForLoadState('load');
  // Network idle is not enough after hydration starts lazy chunks; wait until no request is pending for a while.
  let pending = 0;
  let last = Date.now();
  const began = () => { pending += 1; last = Date.now(); };
  const ended = () => { pending = Math.max(0, pending - 1); last = Date.now(); };
  page.on('request', began);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  try {
    for (const deadline = Date.now() + limitMs; Date.now() < deadline;) {
      if (!pending && Date.now() - last >= quietMs) return;
      await page.waitForTimeout(100);
    }
  } finally {
    page.off('request', began);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
  }
}

/** Load one page cold in a fresh context and read its vitals and transfer. */
export async function measure(browser: Browser, baseURL: string, target: PerfTarget, profile: PerfProfile,
  options: { storageState?: BrowserContextOptions['storageState'] } = {}): Promise<PerfSample> {
  const context = await browser.newContext({ ...profile.context, baseURL, storageState: options.storageState,
    ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    const cdp: CDPSession = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (profile.network) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
    if (profile.cpuSlowdown > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
    const types = new Map<string, string>();
    const transfer: PerfSample['transfer'] = { document: 0, script: 0, stylesheet: 0, font: 0, image: 0, fetch: 0,
      other: 0, total: 0 };
    let requests = 0;
    cdp.on('Network.responseReceived', event => types.set(event.requestId, event.type));
    cdp.on('Network.loadingFinished', event => {
      const kind = kindOf(types.get(event.requestId));
      transfer[kind] += event.encodedDataLength;
      transfer.total += event.encodedDataLength;
      requests += 1;
    });
    await page.addInitScript(observers);
    const response = await page.goto(target.path, { waitUntil: 'commit' });
    if (!response || response.status() >= 400) throw new Error(`${target.path} answered ${response?.status()}`);
    await settle(page, 1_000, profile.network ? 45_000 : 15_000);
    let inp: number | null = null;
    if (target.interact) {
      await target.interact(page);
      await page.waitForTimeout(500);
      inp = await page.evaluate(() => {
        const state = (globalThis as unknown as { __perf: { interactions: Map<number, number> } }).__perf;
        return state.interactions.size ? Math.max(...state.interactions.values()) : 0;
      });
    }
    const vitals = await page.evaluate(() => {
      const state = (globalThis as unknown as { __perf: { lcp: number; lcpElement: string; cls: number;
        fcp: number; tbt: number } }).__perf;
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return { lcp: state.lcp, lcpElement: state.lcpElement, cls: state.cls, fcp: state.fcp, tbt: state.tbt,
        ttfb: navigation ? navigation.responseStart : 0 };
    });
    return { page: target.name, profile: profile.name, url: page.url(), ...vitals, inp, requests, transfer };
  } finally {
    await context.close();
  }
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const ms = (value: number | null) => value === null ? '–' : Math.round(value).toString();

/** A Markdown table of samples, for the handoff and for comparing builds. */
export function formatSamples(samples: readonly PerfSample[]): string {
  const rows = samples.map(sample => `| ${sample.page} | ${sample.profile} | ${ms(sample.ttfb)} | ${ms(sample.fcp)} | `
    + `${ms(sample.lcp)} | ${sample.cls.toFixed(3)} | ${ms(sample.inp)} | ${ms(sample.tbt)} | ${sample.requests} | `
    + `${kb(sample.transfer.document)} | ${kb(sample.transfer.script)} | ${kb(sample.transfer.stylesheet)} | `
    + `${kb(sample.transfer.font)} | ${kb(sample.transfer.image)} | ${kb(sample.transfer.total)} |`);
  return ['| Page | Profile | TTFB | FCP | LCP | CLS | INP | TBT | Req | HTML KB | JS KB | CSS KB | Font KB | Img KB | Total KB |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows].join('\n');
}
