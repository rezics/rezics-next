import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { buildSearchImage, cgroupArgs, waitForSearch } from '../../../../services/kernel/scripts/search.ts';
import { discoveryAlias } from '../../../../services/kernel/src/search/indices.ts';
import type { DiscoveryHttpPage } from '../../../../services/kernel/src/search/http/discovery/page.ts';
import { bundledWebFixtureTimeoutMs, startNativeWebStack, type NativeWebStack } from './stack.ts';
import { readSubjectSearchCutoff } from './subject-publication-observation.ts';

const discoveryWaitMs = 180_000;

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args]);
  if (result.exitCode !== 0) throw new Error(`Owned search setup failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function readMixedDiscovery(stack: NativeWebStack, text: string, ids: readonly string[]) {
  if (!stack.searchWorker) throw new Error('Native mixed Discovery requires the stack Search worker');
  const alias = new URL(`/_alias/${discoveryAlias(stack.searchWorker.prefix)}`, process.env.OPENSEARCH_URL);
  const until = performance.now() + discoveryWaitMs;
  let observation: string;
  do {
    const published = await fetch(alias, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    observation = `alias HTTP ${published.status}`;
    if (published.ok) {
      const response = await stack.kernel('/v1/subjects:search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ representation: 'discovery-v1', text, languages: ['en'], limit: 100 }),
      });
      const body = (await response.json()) as DiscoveryHttpPage & { code?: string };
      if (response.ok) {
        const keys = body.hits.map(({ key }) => key.id);
        if (ids.every((id) => keys.includes(id))) return body;
        observation = `mixed Search HTTP ${response.status}, hit IDs ${JSON.stringify(keys)}`;
      } else {
        observation = `mixed Search HTTP ${response.status}, code ${body.code}`;
      }
    }
    await Bun.sleep(500);
  } while (performance.now() < until);
  throw new Error(`Native mixed Discovery did not serve the created Books: ${observation}`);
}

async function verifyNativeSearch() {
  const priorUrl = process.env.OPENSEARCH_URL;
  let owned: string | undefined;
  let stack: Awaited<ReturnType<typeof startNativeWebStack>> | undefined;
  try {
    if (!priorUrl) {
      owned = `native-search-${randomUUID().slice(0, 12)}`;
      docker([
        'run',
        '-d',
        ...cgroupArgs(),
        '--name',
        owned,
        '-p',
        '127.0.0.1::9200',
        '--tmpfs',
        '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
        '-e',
        'discovery.type=single-node',
        '-e',
        'DISABLE_SECURITY_PLUGIN=true',
        '-e',
        'DISABLE_INSTALL_DEMO_CONFIG=true',
        '-e',
        'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
        buildSearchImage(),
      ]);
      const address = docker(['port', owned, '9200/tcp']).split('\n')[0]!;
      process.env.OPENSEARCH_URL = `http://${address}`;
      await waitForSearch(process.env.OPENSEARCH_URL, owned);
    }
    stack = await startNativeWebStack({ mixedDiscovery: true });
    const marker = `nativewebsearch${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
    const ids: string[] = [];
    for (const name of ['A', 'B']) {
      const created = await stack.kernel(
        '/v1/subjects',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` },
          body: JSON.stringify({ type: 'schema:Book', labels: { en: `${name} ${marker}` } }),
        },
        'editor',
      );
      expect(created.status).toBe(201);
      ids.push(((await created.json()) as { subject: { id: string } }).subject.id);
    }
    const until = performance.now() + 30_000;
    let final: { subjects: { id: string }[] } | undefined;
    while (true) {
      const response = await stack.kernel('/v1/subjects:search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: marker, languages: ['en'] }),
      });
      const body = (await response.json()) as { subjects?: { id: string }[]; code?: string };
      if (response.status === 200 && body.subjects?.length === ids.length) {
        final = body as { subjects: { id: string }[] };
        break;
      }
      if (performance.now() >= until) {
        const failure = new Error(
          `Native search composition did not project books: status=${response.status} code=${body.code}`,
        );
        const sample = await readSubjectSearchCutoff(stack, ids).catch(() => null);
        console.info(`native-web-search-cutoff ${JSON.stringify(sample)}`);
        throw failure;
      }
      await Bun.sleep(100);
    }
    expect(new Set(final.subjects.map((subject) => subject.id))).toEqual(new Set(ids));
    const advanced = await stack.kernel('/v1/subjects:facets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: marker, facets: [{ property: 'type', size: 8 }] }),
    });
    expect(advanced.status).toBe(403);
    expect(((await advanced.json()) as { code: string }).code).toBe('platform_closed');
    const mixed = await readMixedDiscovery(stack, marker, ids);
    expect(mixed.hits.map(({ key }) => key.id).sort()).toEqual([...ids].sort());
    for (const { key, summary } of mixed.hits) {
      expect(key).toMatchObject({ owner: 'semantic', kind: 'schema:Book' });
      expect(summary.kind).toBe('subject');
    }
    expect(mixed.next).toBeNull();
    const page = await stack.request(`/en/search?q=${encodeURIComponent(marker)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    await stack.refreshKernelRequests();
    const webSearch = stack.kernelRequests().filter(({ fixtureRequest }) => !fixtureRequest);
    for (const [url, responseStatus] of [
      ['/v1/subjects:search', 200],
      ['/v1/subjects:facets', 403],
    ] as const) {
      expect(webSearch).toContainEqual(expect.objectContaining({ url, responseStatus, authorization: null }));
    }
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    expect(main).toBeDefined();
    const rendered = main!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    expect(rendered.match(/data-search-recovery="([^"]*)"/)?.[1]).toBeUndefined();
    for (const subjectId of ids) expect(rendered).toContain(subjectId);
    const text = rendered.replace(/<[^>]+>/g, '');
    for (const name of ['A', 'B']) expect(text).toContain(`${name} ${marker}`);
    console.log(
      'native-web-search-demo',
      JSON.stringify({
        query: marker,
        subjects: ids,
        status: 200,
        advancedFacets: advanced.status,
        renderedPage: page.status,
      }),
    );
  } finally {
    try {
      await stack?.stop();
    } finally {
      if (owned) docker(['rm', '-fv', owned]);
      if (priorUrl === undefined) delete process.env.OPENSEARCH_URL;
      else process.env.OPENSEARCH_URL = priorUrl;
    }
  }
}

const timeout =
  (process.env.NATIVE_WEB_BUNDLED_CLIENT === '1' ? bundledWebFixtureTimeoutMs + 120_000 : 360_000) + discoveryWaitMs;
test('native web stack default search returns its API-created matching books', verifyNativeSearch, timeout);
