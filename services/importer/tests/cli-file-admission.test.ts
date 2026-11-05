import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';

// Local input admission proof only. The kernel journey separately proves native effects.
test('malformed descriptor input closes every source without contacting Auth or the API', async () => {
  const directory = await mkdtemp('/dev/shm/import-file-local-');
  try {
    const keyPath = join(directory, 'key.jwk');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(
      keyPath,
      JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
      { mode: 0o600 },
    );
    for (const source of ['bangumi', 'openlibrary', 'wikidata', 'vndb']) {
      const dump = join(directory, `${source}.dump`);
      await writeFile(dump, '{\n', { mode: 0o600 });
      const requests: string[] = [];
      const result = await runImportCli(
        [
          '--source',
          source,
          '--dump',
          dump,
          '--state',
          join(directory, 'state.sqlite'),
          '--api',
          'https://api.import.test',
          '--auth',
          'https://auth.import.test',
          '--account-key',
          keyPath,
          '--account',
          randomUUID(),
          '--client',
          'file-local',
        ],
        {
          fetch: (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
            const request = input instanceof Request ? input : new Request(input, init);
            requests.push(request.url);
            throw new Error('Invalid input reached network');
          }) as typeof fetch,
        },
      );
      expect(requests).toEqual([]);
      expect(result.openHandles).toBe(0);
      expect(result.code, source).toBe(2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
