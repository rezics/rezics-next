import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { Importer } from '../src/importer.ts';
import { ImportSession, importOwnerIsBusy } from '../src/import-session.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { STAGING_ACTIVE_GENERATION, STAGING_INCOMPATIBLE, captureIdentity } from '../src/staging-checkpoint.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const types = [
  { id: 11, type: 1, name: 'Book one' },
  { id: 12, type: 2, name: 'Anime two' },
  { id: 14, type: 4, name: 'Game four' },
  { id: 13, type: 3, name: 'Soundtrack', date: '2024-04-01' },
  { id: 16, type: 6, name: 'Live film', platform: 6002, date: '2024-05' },
] as const;

function subject(row: (typeof types)[number], name: string = row.name) {
  return {
    id: row.id,
    type: row.type,
    name,
    name_cn: `中文 ${row.id}`,
    score: 8.2,
    score_details: { '8': 12 },
    rank: 4,
    ...('date' in row ? { date: row.date } : {}),
    ...('platform' in row ? { platform: row.platform } : {}),
  };
}

function dump(rows: readonly (typeof types)[number][] = types, rename?: (row: (typeof types)[number]) => string) {
  return rows.map((row) => JSON.stringify(subject(row, rename?.(row) ?? row.name))).join('\n') + '\n';
}

function identityOf(bytes: string, extra: Partial<Parameters<typeof captureIdentity>[0]> = {}) {
  return captureIdentity({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.byteLength(bytes),
    sourceAlias: 'bangumi',
    sourceKind: 'bangumi',
    converterRevision: createSourceRegistration('bangumi').converter_revision,
    disappearanceThreshold: 0.2,
    ...extra,
  });
}

function fake() {
  const requests: BatchWriteRequest[] = [];
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 200 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
  };
  return { transport, requests };
}

function wrap(convert: (n: number) => void) {
  const inner = createSourceRegistration('bangumi');
  let n = 0;
  return {
    registration: inner,
    observer: {
      onStagingConversion() {
        convert(++n);
      },
    },
    conversions: () => n,
  };
}

async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}

async function interruptAfter(path: string, input: string, after: number, transport = fake().transport) {
  const controller = new AbortController();
  const first = wrap((n) => {
    if (n === after + 1) {
      controller.abort(new DOMException('stop', 'AbortError'));
      throw controller.signal.reason;
    }
  });
  const importer = new Importer({ path, transport, observer: first.observer });
  const interrupted = await importer.runDump(first.registration, bytes(input), {
    signal: controller.signal,
    checkpoint: { action: 'acquire', identity: identityOf(input) },
  });
  return { importer, interrupted, conversions: first.conversions() };
}

test('checkpointed Bangumi staging resumes the same generation for every admitted type without ratings or prefix reconversion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bangumi-staging-'));
  const input = dump();
  const f = fake();
  const { importer, interrupted, conversions } = await interruptAfter(`${dir}/state.sqlite`, input, 2, f.transport);
  try {
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.checkpointed).toBe(true);
    expect(interrupted.committedPrefix).toBe(2);
    expect(f.requests).toHaveLength(0);
    expect(conversions).toBe(3);
    const stored = importer.session.store.stagingCheckpoint('bangumi', interrupted.runId!);
    expect(stored?.identity.sourceKind).toBe('bangumi');
    expect(stored?.committedOrdinal).toBe(2);
    const prefix = importer.session.store.database
      .query('SELECT COUNT(*) AS n FROM run_staging_prefix WHERE source=? AND run_id=?')
      .get('bangumi', interrupted.runId!) as { n: number };
    expect(prefix.n).toBe(2);
  } finally {
    await importer.close();
  }
  const second = wrap(() => {});
  let verified = 0;
  let staged = 0;
  const resumed = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: second.observer });
  try {
    const result = await resumed.runDump(second.registration, bytes(input), {
      checkpoint: { action: 'resume', generation: '1', identity: identityOf(input) },
      progress: {
        onVerifiedPrefix: (count) => (verified += count),
        onStaged: (count) => (staged += count),
      },
    });
    expect(result.status).toBe('committed');
    expect(second.conversions()).toBe(3);
    expect(verified).toBe(2);
    expect(staged).toBe(3);
    expect(f.requests.length).toBeGreaterThan(0);
    const body = JSON.stringify(f.requests);
    expect(body).not.toContain('score');
    expect(body).not.toContain('score_details');
    expect(body).not.toContain('"rank"');
    const created = f.requests.flatMap((request) =>
      request.commands.filter((command) => command.op === 'create').map((command) => command.subject.type),
    );
    expect(created.sort()).toEqual(
      ['schema:Book', 'schema:Movie', 'schema:MusicAlbum', 'schema:TVSeries', 'schema:VideoGame'].sort(),
    );
    expect(resumed.session.store.source('bangumi').count).toBe(5);
    expect(resumed.session.store.stagingCheckpoint('bangumi', '1')).toBeNull();
  } finally {
    await resumed.close();
    rmSync(dir, { recursive: true });
  }
});

test('Bangumi checkpoint rejects changed suffix, kind, alias, converter, missing projection and active capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bangumi-staging-fail-'));
  const input = dump();
  const identity = identityOf(input);
  const f = fake();
  const { importer, interrupted } = await interruptAfter(`${dir}/state.sqlite`, input, 2, f.transport);
  try {
    expect(interrupted.committedPrefix).toBe(2);
    const suffix = dump(types, (row) => (row.id === 16 ? 'Live filn' : row.name));
    expect(Buffer.byteLength(suffix)).toBe(Buffer.byteLength(input));
    const changed = await importer.runDump(createSourceRegistration('bangumi'), bytes(suffix), {
      checkpoint: { action: 'resume', generation: '1', identity: identityOf(suffix) },
    });
    expect(changed.status).toBe('invalid-dump');
    expect(changed.diagnostic).toBe(STAGING_INCOMPATIBLE);
    expect(importer.session.store.stagingCheckpoint('bangumi', '1')?.committedOrdinal).toBe(2);
    for (const extra of [
      { sourceKind: 'openlibrary' as const },
      { sourceAlias: 'community-bangumi' },
      { converterRevision: 'bangumi@4' },
      { disappearanceThreshold: 0.5 },
    ]) {
      const mismatch = await importer.runDump(createSourceRegistration('bangumi'), bytes(input), {
        checkpoint: { action: 'resume', generation: '1', identity: { ...identity, ...extra } },
      });
      expect(mismatch.status).toBe('invalid-dump');
    }
    importer.session.store.database
      .prepare('UPDATE run_entries SET projection_json=? WHERE source=? AND run_id=? AND record_key=?')
      .run('', 'bangumi', '1', '11');
    const missing = await importer.runDump(createSourceRegistration('bangumi'), bytes(input), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(missing.status).toBe('invalid-dump');
    expect(missing.diagnostic).toBe(STAGING_INCOMPATIBLE);
    const truncated = await importer.runDump(createSourceRegistration('bangumi'), bytes(input.slice(0, 40)), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(truncated.status).toBe('invalid-dump');
    expect(importer.session.store.stagingCheckpoint('bangumi', '1')?.committedOrdinal).toBe(2);
    const busy = await importer.runDump(createSourceRegistration('bangumi'), bytes(input), {
      checkpoint: { action: 'acquire', identity },
    });
    expect(busy.diagnostic).toBe(STAGING_ACTIVE_GENERATION);
    expect(f.requests).toHaveLength(0);
  } finally {
    await importer.close();
    rmSync(dir, { recursive: true });
  }
});

test('duplicate keys and a malformed trailing record cannot seal a shorter Bangumi catalogue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bangumi-staging-tail-'));
  const f = fake();
  const duplicated = dump([types[0]!, types[1]!, types[0]!]);
  const { importer, interrupted } = await interruptAfter(`${dir}/dup.sqlite`, duplicated, 2, f.transport);
  try {
    expect(interrupted.committedPrefix).toBe(2);
    const resumed = await importer.runDump(createSourceRegistration('bangumi'), bytes(duplicated), {
      checkpoint: { action: 'resume', generation: '1', identity: identityOf(duplicated) },
    });
    expect(resumed.status).toBe('invalid-dump');
    expect(importer.session.store.stagingCheckpoint('bangumi', '1')?.committedOrdinal).toBe(2);
  } finally {
    await importer.close();
  }
  const broken = `${dump([types[0]!, types[1]!, types[2]!])}{"id":16,"type":6,"name":\n`;
  const second = await interruptAfter(`${dir}/tail.sqlite`, broken, 2, f.transport);
  try {
    expect(second.interrupted.committedPrefix).toBe(2);
    const resumed = await second.importer.runDump(createSourceRegistration('bangumi'), bytes(broken), {
      checkpoint: { action: 'resume', generation: '1', identity: identityOf(broken) },
    });
    expect(resumed.status).toBe('invalid-dump');
    expect(second.importer.session.store.stagingCheckpoint('bangumi', '1')?.committedOrdinal).toBe(2);
    expect(f.requests).toHaveLength(0);
  } finally {
    await second.importer.close();
    rmSync(dir, { recursive: true });
  }
});

test('Bangumi checkpoint start treats a live or uninspectable owner as busy, and a PID reuse as recoverable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bangumi-staging-owner-'));
  const a = new ImportSession(`${dir}/state.sqlite`);
  const b = new ImportSession(`${dir}/state.sqlite`);
  try {
    const own = a.acquire('bangumi');
    if (own === 'busy') throw 0;
    expect(b.acquire('bangumi')).toBe('busy');
    a.release(own);
    expect(importOwnerIsBusy({ pid: process.pid, birth: 'not-a-birth' })).toBe(true);
    a.store.database
      .prepare('INSERT INTO import_owners VALUES(?,?,?,?)')
      .run('bangumi', process.pid, 'different-birth', 'old');
    const reused = a.acquire('bangumi');
    expect(reused).not.toBe('busy');
    if (reused !== 'busy') a.release(reused);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true });
  }
});

test('CLI interrupt names the Bangumi generation and resume finishes without importing ratings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-staging-cli-'));
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = join(directory, 'key.jwk');
  const dumpPath = join(directory, 'bangumi.jsonl');
  const state = join(directory, 'state.sqlite');
  const account = '00000000-0000-4000-8000-000000000001';
  const origin = 'http://127.0.0.1:43180';
  const input = dump();
  await writeFile(
    keyPath,
    JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'bangumi-staging', alg: 'ES256', key_ops: ['sign'] }),
    { mode: 0o600 },
  );
  await writeFile(dumpPath, input);
  const metadata = sourceRecordMetadataFixture();
  const f = fake();
  const bodies: string[] = [];
  const argv = (mode: 'checkpoint-staging' | 'resume-staging', generation = '1') => [
    '--source',
    'bangumi',
    '--dump',
    dumpPath,
    '--state',
    state,
    '--api',
    origin,
    '--auth',
    'https://auth.importer.test',
    '--account-key',
    keyPath,
    '--account',
    account,
    '--client',
    'local',
    ...(mode === 'resume-staging' ? ['--resume-staging', '--generation', generation] : ['--checkpoint-staging']),
  ];
  const fetchRemote = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://auth.importer.test') {
      if (url.pathname === '/signin/key')
        return Response.json({}, { headers: { 'set-cookie': 'session=scope; HttpOnly; Secure' } });
      if (url.pathname === '/token')
        return Response.json({ access_token: 'SCOPE_TOKEN', token_type: 'Bearer', expires_in: 300 });
    }
    const text = await request.clone().text();
    bodies.push(text);
    if (url.pathname === '/v1/source-records:setMetadata') return metadata.fetch(request);
    if (url.pathname === '/v1/sourceFences:check') return Response.json(await f.transport.readFence());
    expect(url.pathname).toBe('/v1/subjects:batchWrite');
    return Response.json(await f.transport.batchWrite(JSON.parse(text) as BatchWriteRequest));
  }) as unknown as typeof fetch;
  try {
    const controller = new AbortController();
    let conversions = 0;
    const interrupted = await runImportCli(argv('checkpoint-staging'), {
      signal: controller.signal,
      testOrigin: origin,
      observer: {
        onCoordinator({ registration }) {
          const convert = registration.convert.bind(registration);
          (registration as { convert: typeof convert }).convert = (record, context) => {
            if (!context.subjectId) conversions++;
            const result = convert(record, context);
            if (conversions === 2) controller.abort(new DOMException('stop', 'AbortError'));
            return result;
          };
        },
      },
      fetch: fetchRemote,
    });
    expect(interrupted.code).toBe(130);
    expect(interrupted.stderr).toContain('--resume-staging');
    expect(interrupted.stderr).toContain('generation 1');
    expect(interrupted.stderr).not.toContain('score');
    expect(f.requests).toHaveLength(0);
    conversions = 0;
    const resumed = await runImportCli(argv('resume-staging'), {
      testOrigin: origin,
      observer: {
        onCoordinator({ registration }) {
          const convert = registration.convert.bind(registration);
          (registration as { convert: typeof convert }).convert = (record, context) => {
            if (!context.subjectId) conversions++;
            return convert(record, context);
          };
        },
      },
      fetch: fetchRemote,
    });
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('committedPrefix=5');
    expect(conversions).toBe(3);
    expect(bodies.join('\n')).not.toContain('"score"');
    expect(bodies.join('\n')).not.toContain('score_details');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
