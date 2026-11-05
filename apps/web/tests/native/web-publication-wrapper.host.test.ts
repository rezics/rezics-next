import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const scenarios = [
  'subject-traversal: editions are reachable once in declared order across full pages',
  'subject-traversal: contents are reachable once in declared order across full pages',
  'subject-traversal: cast is reachable once in declared order across full pages',
  'subject-traversal: crew is reachable once in declared order across full pages',
  'subject-traversal: inverse credits are reachable once in declared order across full pages',
  'subject-traversal: relations are reachable once in declared order across full pages',
  'subject-traversal: credit character credited name position and spoiler retain their meaning',
  'subject-traversal: Details reaches competing sourced date and editorial history',
  'published-vertical-metadata: Book publishes author word count light-novel form and harem tag',
  'published-vertical-metadata: Recipe publishes instructions diet and PT25M cook time',
  'published-vertical-metadata: game metadata agrees with the rendered work',
  'published-vertical-metadata: release metadata preserves release identity and facts',
  'published-vertical-metadata: person metadata agrees with the rendered person',
  'published-vertical-metadata: organization metadata agrees with the rendered organization',
  'published-vertical-metadata: automated account metadata agrees with the rendered agent',
  'published-vertical-metadata: withheld facts are absent from HTML and JSON-LD',
  'published-vertical-metadata: stale slug redirects to the canonical localized slug',
  'published-vertical-metadata: verified agent subject redirects to its handle page',
  'published-vertical-metadata: configured alternate public origin is canonical',
  'public-discovery-and-cache: robots and every sitemap shard publish exactly eligible native feed URLs',
  'public-discovery-and-cache: Alice warming a public page cannot leak personal facts to anonymous or Bob',
  'public-discovery-and-cache: private hydration requires Alice current authority',
  'page-states: preparing subject view is useful retryable and does not cache an error',
  'page-states: unavailable owner read serves an unavailable page with Retry-After',
  'page-states: private Collection is indistinguishable from missing to anonymous',
  'page-states: empty public list explicitly says it is empty',
  'page-states: native suspended persona personal read is 401 invalid_credentials with invalid_token challenge and no personal content',
  'search-page: anonymous zh-Hans Book search renders native order localized unique facets and no engine totals',
];

async function streamOutput(stream: ReadableStream<Uint8Array>, write: (chunk: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    chunks.push(chunk);
    write(chunk);
  }
  const finalChunk = decoder.decode();
  if (finalChunk) {
    chunks.push(finalChunk);
    write(finalChunk);
  }
  return chunks.join('');
}

describe('native web publication wrapper', () => {
  test('registers every frozen scenario and only reports served outcome failures', async () => {
    const root = resolve(import.meta.dir, '../../../..');
    const child = Bun.spawn(['bun', 'test', './apps/web/tests/native/web-publication-outcomes.host.test.ts'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, WEB_PUBLICATION_DRIVER: undefined },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      streamOutput(child.stdout, (chunk) => process.stdout.write(chunk)),
      streamOutput(child.stderr, (chunk) => process.stderr.write(chunk)),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;
    console.info(
      `publication-outcomes-subprocess: exit=${exitCode} stdout-bytes=${Buffer.byteLength(stdout)} stderr-bytes=${Buffer.byteLength(stderr)}`,
    );
    expect(exitCode).not.toBeNull();
    for (const scenario of scenarios) expect(output).toContain(scenario);
    expect(output).toMatch(/\d+ pass/);
    expect(output).not.toMatch(
      /WEB_PUBLICATION_DRIVER is required|driver (?:method|factory)|createWebPublicationDriver|provision|settle|timed out|timeout|web Worker exited during startup|ReferenceError: Bun is not defined|beforeEach hook failed/i,
    );
    expect(output).toMatch(/\d+ fail/);
  }, 3_600_000);
});
