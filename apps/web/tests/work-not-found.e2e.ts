import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { resourceHref } from '../features/address/path.ts';
import { studioHref } from '../features/studio/agent.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { canonicalFlight } from './work-response.ts';

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// Route refs in bootstrap data and sign-in return addresses describe the request, not the Work.
function normalizeAddress(value: string, ref: string): string {
  return value.replaceAll(encodeURIComponent(ref), 'work-ref').replaceAll(ref, 'work-ref');
}

async function responseBody(page: Page, body: string, ref: string, link: string | undefined): Promise<{ body: string; link: string }> {
  const content = await page.evaluate(({ html, link }) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const primary: string[] = [];
    const compatibility: string[] = [];
    // The shell's community navigation can finish before the first flush or in a later React segment.
    // Expand the streamed segment, retaining its content and all serialized RSC data.
    for (const segment of doc.querySelectorAll('div[hidden][id^="S:"]')) {
      const slot = doc.getElementById(`B:${segment.id.slice(2)}`);
      if (!slot) continue;
      let next = slot.nextSibling;
      let depth = 0;
      while (next) {
        if (next.nodeType === Node.COMMENT_NODE) {
          if (next.nodeValue === '/$') {
            if (depth === 0) break;
            depth--;
          } else if (next.nodeValue?.startsWith('$')) depth++;
        }
        const following = next.nextSibling;
        next.remove();
        next = following;
      }
      slot.replaceWith(...segment.childNodes);
      segment.remove();
    }
    // These are React's segment insertion/timing helpers, never application bootstrap data.
    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent ?? '';
      const marker = '.rsc.push(';
      const start = text.indexOf(marker);
      if (text.startsWith('((self[Symbol.for("vinext.navigationRuntime")]') && start >= 0) {
        const payload: unknown = JSON.parse(text.slice(start + marker.length).replace(/\);?$/, ''));
        if (typeof payload !== 'string') throw new Error('Unexpected Flight payload');
        primary.push(payload);
        script.remove();
        continue;
      }
      const legacy = text.match(/^self\.__next_f\.push\(\[1,([\s\S]*)\]\);?$/);
      if (legacy) {
        const payload: unknown = JSON.parse(legacy[1]!);
        if (typeof payload !== 'string') throw new Error('Unexpected compatibility payload');
        compatibility.push(payload);
        script.remove();
        continue;
      }
      if (script.textContent?.startsWith('$RB=[];$RV=function')
        || script.textContent?.startsWith('requestAnimationFrame(function(){$RT=')) script.remove();
    }
    const comments = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
    const markers: Node[] = [];
    while (comments.nextNode()) if (/^(?:\$[?!~]?|\/\$)$/.test(comments.currentNode.nodeValue ?? '')) markers.push(comments.currentNode);
    for (const marker of markers) marker.parentNode?.removeChild(marker);
    // A font hint can move wholly into HTTP Link. Lift its complete metadata back into the compared body.
    const remaining = (link ?? '').split(/,\s*(?=<)/).filter(part => {
      const style = part.match(/^<(\/_next\/static\/css\/[^>]+\.css)>; rel=preload; as="style"$/);
      if (style && [...doc.querySelectorAll('link[rel="stylesheet"]')].some(node => node.getAttribute('href') === style[1])) return false;
      const font = part.match(/^<(\/_next\/static\/media\/[^>]+\.woff2)>; rel=preload; as="font"; crossorigin="anonymous"; type="font\/woff2"$/);
      if (!font) return Boolean(part);
      if (![...doc.querySelectorAll('link[rel="preload"][as="font"]')].some(node => node.getAttribute('href') === font[1])) {
        const preload = doc.createElement('link');
        for (const [key, value] of Object.entries({ rel: 'preload', as: 'font', href: font[1]!, crossorigin: 'anonymous', type: 'font/woff2' })) preload.setAttribute(key, value);
        doc.head.append(preload);
      }
      return false;
    });
    // Preload locations/order follow segment timing. Compare their complete tags in a fixed location.
    const preloads = [...doc.querySelectorAll('link[rel="modulepreload"],link[rel="preload"]')];
    for (const preload of preloads) {
      const attributes = [...preload.attributes].sort((a, b) => a.name.localeCompare(b.name));
      for (const attribute of attributes) preload.removeAttribute(attribute.name);
      for (const attribute of attributes) preload.setAttribute(attribute.name, attribute.value);
    }
    preloads.sort((a, b) => a.outerHTML.localeCompare(b.outerHTML));
    for (const preload of preloads) doc.head.append(preload);
    return { body: doc.documentElement.outerHTML, primary: primary.join(''), compatibility: compatibility.join(''), link: remaining.join(', ') };
  }, { html: normalizeAddress(body, ref), link });
  expect(content.primary).toBe(content.compatibility);
  return { body: JSON.stringify({ html: content.body, flight: canonicalFlight(content.primary) }), link: content.link };
}

async function missingPage(page: Page, address: string, tail: string) {
  const ref = address.split('/').at(-1)!;
  const response = await page.goto(`${localizedPath(address, 'en')}${tail}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Work not found', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Work not found · REZICS');
  const headers = await response!.allHeaders();
  const content = await responseBody(page, await response!.text(), ref, headers.link);
  if (content.link) headers.link = content.link;
  else delete headers.link;
  // Transport timestamps and tracing describe an individual request. Cache/security headers remain compared.
  for (const name of ['date', 'server-timing', 'x-request-id', 'traceparent']) delete headers[name];
  return {
    status: response!.status(),
    text: await page.locator('main').innerText(),
    title: await page.title(),
    body: content.body,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, normalizeAddress(value, ref)])),
  };
}

test('signed-out private and missing Works have the same 404 across Work, read and edit routes', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const member = fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  const session = fixture<{ actingSubject: string }>('REZICS_WEB_AUTH_PUBLIC_PATH');
  const owner = await browser.newContext({ baseURL: info.project.use.baseURL });
  let work = '';
  const title = `Private ledger ${crypto.randomUUID()}`;
  try {
    const page = await owner.newPage();
    await signInAtAccounts(page, localizedPath(studioHref({ iri: session.actingSubject, handle: null }), 'en'), member);
    let writer = '';
    const agentKey = crypto.randomUUID();
    await expect(async () => {
      const response = await owner.request.post('/api/main/v1/agents', {
        headers: { 'idempotency-key': agentKey },
        data: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Private Work writer' },
      });
      expect([200, 201]).toContain(response.status());
      writer = ((await response.json()) as { agent: string }).agent;
    }).toPass({ timeout: 40_000 });
    const workKey = crypto.randomUUID();
    await expect(async () => {
      const response = await owner.request.post('/api/main/v1/works', {
        headers: { 'idempotency-key': workKey },
        data: { profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Book'],
          authoring: 'own-work', actingSubject: writer },
      });
      expect([200, 201]).toContain(response.status());
      work = ((await response.json()) as { work: string }).work.slice(-36);
    }).toPass({ timeout: 40_000 });
    // Prove the comparison uses a real private Work, rather than two nonexistent records.
    await expect(async () => {
      const response = await owner.request.get(`/api/main/v1/works/${work}?actingSubject=${encodeURIComponent(writer)}`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(title);
    }).toPass({ timeout: 40_000 });
  } finally {
    await owner.close();
  }

  const missing = crypto.randomUUID();
  const privateAddress = resourceHref('/w/', work);
  const missingAddress = resourceHref('/w/', missing);
  const chapter = crypto.randomUUID();
  const tails = ['', '/contents', '/versions', '/editions', '/connections', '/discussion', '/history',
    '/read', `/read/${chapter}`, '/edit', '/edit/parts', '/edit/relations', '/edit/editions', '/edit/showcase'];
  for (const width of [390, 1280]) {
    const anonymous = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width, height: 844 } });
    try {
      for (const id of [work, missing]) {
        const response = await anonymous.request.get(`/api/main/v1/works/${id}`);
        expect(response.status()).toBe(404);
        expect(await response.text()).not.toContain(title);
      }
      const slash = await Promise.all([privateAddress, missingAddress].map(address =>
        anonymous.request.get(localizedPath(`${address}/`, 'en'), { maxRedirects: 0 })));
      expect(slash.map(response => response.status())).toEqual([404, 404]);
      expect(await slash[0]!.text()).toBe(await slash[1]!.text());
      const page = await anonymous.newPage();
      for (const tail of tails) {
        await test.step(`${width}px ${tail || 'overview'}`, async () => {
          const privatePage = await missingPage(page, privateAddress, tail);
          const missing = await missingPage(page, missingAddress, tail);
          expect(privatePage.text).not.toContain(title);
          expect(privatePage.body).not.toContain(title);
          if (missing.body !== privatePage.body) {
            await info.attach('private-work-response', { body: privatePage.body, contentType: 'text/html' });
            await info.attach('missing-work-response', { body: missing.body, contentType: 'text/html' });
          }
          expect.soft(missing).toEqual(privatePage);
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
          if (!tail || tail === '/read' || tail === '/edit/parts') {
            await page.screenshot({ path: info.outputPath(`work-not-found-${width}-${tail ? tail.replaceAll('/', '-') : 'overview'}.png`), fullPage: true });
          }
        });
      }
    } finally {
      await anonymous.close();
    }
  }
});
