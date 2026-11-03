import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

test('ordinary Bangumi registration converts named 3/6 records and keeps identity-only ignored seams', () => {
  const registration = createSourceRegistration('bangumi');
  const context = { source: 'bangumi', subjectId: '00000000-0000-4000-8000-000000000001' };
  const convert = (record: unknown) =>
    registration.convert({ external_id: '71001', record_revision: null, record }, context);
  const initial = convert({ id: 71001, type: 1, name: 'The Cartographer’s Book' });
  const seen: string[] = [];
  for (const type of [3, 6]) {
    const record = { id: 71001, type };
    for (const field of ['name_cn', 'summary', 'images', 'tags', 'user_posts', 'reviews']) {
      Object.defineProperty(record, field, {
        enumerable: true,
        get() {
          seen.push(field);
          throw new Error('Discarded field was visited');
        },
      });
    }
    const ignored = convert(record);
    expect('outcome' in ignored && ignored.outcome).toBe('ignored');
    expect(ignored.normalized).toEqual({ id: 71001, type });
    expect(ignored.proposals).toEqual([]);
    expect(ignored.mediaImportIntents).toEqual([]);
    expect(convert(JSON.parse(JSON.stringify(ignored.normalized)))).toEqual(ignored);
    expect(ignored.digest).not.toBe(initial.digest);
    const named = convert({
      id: 71001,
      type,
      name: type === 3 ? 'The Observatory Soundtrack' : 'The Cartographer Live Action',
      date: '2024-04-01',
      platform: type === 6 ? 'movie' : '0',
    });
    expect(named.outcome).toBe('converted');
    expect(named.proposals.some((proposal) => proposal.op === 'create')).toBe(false);
    expect(named.proposals.length).toBeGreaterThan(0);
    expect(named.digest).not.toBe(ignored.digest);
    expect(convert(JSON.parse(JSON.stringify(named.normalized)))).toEqual(named);
  }
  expect(seen).toEqual([]);
  const returned = convert({ id: 71001, type: 1, name: 'The Cartographer’s Book: Revised' });
  expect(registration.converter_revision).toBe('bangumi@5');
  expect(returned.digest).not.toBe(initial.digest);
  expect(returned.proposals).toHaveLength(2);
  expect(convert(JSON.parse(JSON.stringify(returned.normalized)))).toEqual(returned);
  for (const proposal of returned.proposals) {
    expect(proposal.op).toBe('propose');
    expect(proposal.source).toMatchObject({ source: 'bangumi', external_id: '71001', converter_revision: 'bangumi@5' });
  }
});

test('ordinary Bangumi CLI seals the whole transition input before any Auth or public request', async () => {
  const directory = await mkdtemp('/dev/shm/bangumi-scope-cli-local-');
  try {
    const keyPath = join(directory, 'account.jwk');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(
      keyPath,
      JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
      { mode: 0o600 },
    );
    const requests: string[] = [];
    const revisions: string[] = [];
    const result = await runImportCli(
      [
        '--source',
        'bangumi',
        '--dump',
        '-',
        '--state',
        join(directory, 'state.sqlite'),
        '--account-key',
        keyPath,
        '--account',
        randomUUID(),
        '--client',
        'scope-cli-local',
        '--api',
        'https://api.import.test',
        '--auth',
        'https://auth.import.test',
      ],
      {
        stdin: (async function* () {
          yield new TextEncoder().encode('{"id":71001,"type":3,"summary":{"private":"DISCARDED"}}\n{"id":');
        })(),
        observer: {
          onCoordinator({ registration }) {
            revisions.push(registration.converter_revision);
          },
        },
        fetch: (async (request: Request) => {
          requests.push(request.url);
          throw new Error('Unexpected request before sealing');
        }) as unknown as typeof fetch,
      },
    );
    expect(revisions).toEqual(['bangumi@5']);
    expect(result.code).toBe(2);
    expect(result.openHandles).toBe(0);
    expect(requests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
