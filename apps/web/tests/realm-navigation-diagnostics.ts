import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';

/** Keep navigation failures reviewable without changing a journey's assertions. */
export async function realmNavigationDiagnostics(page: Page, info: TestInfo, name: string) {
  const events: unknown[] = [];
  const reads: Promise<void>[] = [];
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) events.push({ event: 'navigation', url: frame.url(), at: new Date().toISOString() });
  });
  page.on('pageerror', error => events.push({ event: 'pageerror', name: error.name, message: error.message }));
  page.on('requestfailed', request => events.push({ event: 'requestfailed', url: request.url(),
    method: request.method(), failure: request.failure() }));
  page.on('response', response => {
    const request = response.request(), url = new URL(response.url());
    if (!url.pathname.includes('/discussions') && !url.pathname.includes('/threads')
      && !url.pathname.includes('/typeahead')) return;
    reads.push((async () => {
      const headers = await response.allHeaders();
      const record = { event: 'response', at: new Date().toISOString(), url: response.url(),
        method: request.method(), status: response.status(), requestHeaders: {
          rsc: request.headers().rsc, nextUrl: request.headers()['next-url'],
        }, headers: { location: headers.location, cacheControl: headers['cache-control'],
          contentType: headers['content-type'], traceparent: headers.traceparent },
        bodyState: 'pending', body: '' };
      events.push(record);
      // A redirected or abandoned Flight stream can outlive the assertion.
      // Diagnostics must preserve that assertion and flush its trace promptly.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const body = await Promise.race([response.text().catch(() => null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
      clearTimeout(timer);
      record.bodyState = body === null ? 'unavailable' : 'complete';
      record.body = body?.slice(0, 262_144) ?? '';
    })());
  });
  return async () => {
    await Promise.allSettled(reads);
    events.push({ event: 'closing-page', url: page.url() });
    const network = info.outputPath(`${name}-network.json`), trace = info.outputPath(`${name}-trace.zip`);
    await writeFile(network, JSON.stringify(events, null, 2));
    await page.context().tracing.stop({ path: trace });
    await info.attach(`${name}-network`, { path: network, contentType: 'application/json' });
    await info.attach(`${name}-trace`, { path: trace, contentType: 'application/zip' });
  };
}
