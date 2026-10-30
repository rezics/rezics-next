import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

// Local admission proof only. The native operator lifecycle is separately bound
// in kernel/test/imports/openlibrary-cli-edition-media-fixture.ts.
for (const failure of ['truncated row', 'mismatched identity', 'invalid ISBN'] as const) {
  test(`Open Library CLI seals the whole cover-bearing TSV before effects: ${failure}`, async () => {
    const directory = await mkdtemp('/dev/shm/openlibrary-cli-admission-');
    try {
      const path = join(directory, 'account.jwk');
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      await writeFile(
        path,
        JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'admission', alg: 'ES256' }),
        { mode: 0o600 },
      );
      const edition = { ...editionSource, covers: [900000002, 900000003, -1], languages: [{ key: '/languages/eng' }] };
      const row = (record: typeof edition, key = record.key) =>
        [record.type.key, key, record.revision, record.last_modified.value, JSON.stringify(record)].join('\t') + '\n';
      const suffix =
        failure === 'truncated row'
          ? '/type/edition\t/books/OL1M\t1\t2025-01-01\t{"key":'
          : failure === 'mismatched identity'
            ? row(edition, '/books/OL1M')
            : row({ ...edition, key: '/books/OL1M', isbn_13: ['9780306406158'] });
      const requests: string[] = [];
      const result = await runImportCli(
        [
          '--source',
          'openlibrary',
          '--dump',
          '-',
          '--state',
          join(directory, 'state.sqlite'),
          '--api',
          'https://kernel.import.test',
          '--auth',
          'https://auth.import.test',
          '--account-key',
          path,
          '--account',
          '00000000-0000-4000-8000-000000000001',
          '--client',
          'admission',
        ],
        {
          stdin: (async function* () {
            // A valid cover-bearing record arrives before the hostile suffix, in
            // separate chunks. No effect may escape before EOF and validation.
            yield new TextEncoder().encode(row(edition));
            yield new TextEncoder().encode(suffix);
          })(),
          fetch: (async (input: Request | string | URL) => {
            requests.push(input instanceof Request ? input.url : String(input));
            throw new Error('Unexpected effect before complete source admission');
          }) as typeof fetch,
        },
      );
      expect(result.code).toBe(2);
      expect(result.openHandles).toBe(0);
      expect(requests).toEqual([]);
      expect(result.stderr).not.toContain(edition.notes.value);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
