import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportTransport, ImportTransportError } from '../src/import-client.ts';
import { createSeedDenialDiagnostics } from '../src/showcase-denial-diagnostics.ts';

test('first native denial preserves exact problem bytes privately and remains a refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seed-denial-'));
  const output: string[] = [];
  const body = ' {"type":"about:blank","status":403,"detail":"remote-secret"}\n';
  let requests = 0;
  const subjectId = '00000000-0000-4000-8000-000000000101';
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'private-token',
    onDeniedResponse: createSeedDenialDiagnostics(root, (line) => output.push(line)),
    fetch: (async (request: Request) => {
      requests++;
      expect(request.headers.get('authorization')).toBe('Bearer private-token');
      return new Response(body, {
        status: 403,
        headers: { 'content-type': 'application/problem+json', 'set-cookie': 'session=private-session' },
      });
    }) as typeof fetch,
  });
  try {
    for (let i = 0; i < 2; i++) {
      const failure = await transport.readSourceStatistics({ subjectId }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ImportTransportError);
      expect((failure as ImportTransportError).status).toBe(403);
    }
    expect(requests).toBe(2);
    expect(output).toHaveLength(1);
    const diagnostic = JSON.parse(output[0]!);
    expect(diagnostic).toMatchObject({ stage: 'source-statistics', method: 'GET', status: 403, subject: subjectId });
    expect(output.join('')).not.toMatch(/remote-secret|private-token|private-session/);
    expect(await readFile(join(diagnostic.artifact, 'response.body'), 'utf8')).toBe(body);
    expect((await stat(join(diagnostic.artifact, 'response.body'))).mode & 0o777).toBe(0o600);
    expect((await stat(diagnostic.artifact)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
