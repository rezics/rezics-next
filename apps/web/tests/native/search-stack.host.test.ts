import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { buildSearchImage, cgroupArgs, waitForSearch } from '../../../../services/kernel/scripts/search.ts';
import { startNativeWebStack } from './stack.ts';

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args]);
  if (result.exitCode !== 0) throw new Error(`Owned search setup failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

test('native web stack default search returns its API-created matching books', async () => {
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
    stack = await startNativeWebStack();
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
      if (performance.now() >= until)
        throw new Error(`Native search composition did not project books: status=${response.status} code=${body.code}`);
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
    const page = await stack.request(`/en/search?q=${encodeURIComponent(marker)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    expect(main).toBeDefined();
    const rendered = main!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
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
}, 360_000);
