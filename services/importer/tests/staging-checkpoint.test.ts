import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { Importer } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import {
  STAGING_ACTIVE_GENERATION,
  STAGING_INCOMPATIBLE,
  STAGING_OLD_UNSUPPORTED,
  STAGING_SEALED_RESUME,
  captureIdentity,
  evaluateResume,
  extendPrefixDigest,
  emptyPrefixDigest,
} from '../src/staging-checkpoint.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);

function wiki(id: number, title = `Title ${id}`) {
  const record = structuredClone(fixture);
  record.id = `Q${id}`;
  record.labels.en.value = title;
  for (const claims of Object.values(record.claims) as { id: string }[][])
    for (const claim of claims) claim.id = claim.id.replace(/^Q1\$/, `${record.id}$`);
  return record;
}

function wikiDump(records: ReturnType<typeof wiki>[]) {
  return `[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`;
}

function olLine(id: number, title: string) {
  const key = `/works/OL${id}W`;
  const json = JSON.stringify({
    type: { key: '/type/work' },
    key,
    revision: 1,
    title,
  });
  return `/type/work\t${key}\t1\t2020-01-01T00:00:00.000000\t${json}\n`;
}

function identityOf(bytes: string, extra: Partial<Parameters<typeof captureIdentity>[0]> = {}) {
  return captureIdentity({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.byteLength(bytes),
    sourceAlias: 'wikidata',
    sourceKind: 'wikidata',
    converterRevision: createSourceRegistration('wikidata').converter_revision,
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

function wrap(kind: 'wikidata' | 'openlibrary', convert: (n: number) => void) {
  const inner = createSourceRegistration(kind);
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

test('help names checkpointed staging, and unsupported producers fail before network', async () => {
  const help = await runImportCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--checkpoint-staging');
  expect(help.stdout).toContain('--resume-staging');
  expect(help.stdout).toContain('re-hash');
  expect(help.stdout).toContain('Bangumi');
  expect(help.stdout).toContain('ratings stay omitted');
  expect(help.stdout).toContain('Local conversion is not publication');
  const directory = await mkdtemp(join(tmpdir(), 'staging-cli-'));
  const requests: string[] = [];
  try {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPath = join(directory, 'key.jwk');
    await writeFile(
      keyPath,
      JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
      { mode: 0o600 },
    );
    const blocked = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('checkpoint admission reached network');
    }) as unknown as typeof fetch;
    const credentials = [
      '--state',
      join(directory, 'missing.sqlite'),
      '--api',
      'https://api.test',
      '--auth',
      'https://auth.test',
      '--account-key',
      keyPath,
      '--account',
      randomUUID(),
      '--client',
      'local',
    ];
    await writeFile(join(directory, 'dump.json'), '[]\n');
    const refused = [
      ['--source', 'vndb', '--dump', join(directory, 'dump.json'), '--checkpoint-staging'],
      ['--source', 'bangumi', '--dump', join(directory, 'dump.json'), '--compression', 'gzip', '--checkpoint-staging'],
      ['--source', 'wikidata', '--dump', join(directory, 'dump.json'), '--compression', 'gzip', '--checkpoint-staging'],
      ['--source', 'bangumi', '--dump', '-', '--checkpoint-staging'],
      ['--source', 'wikidata', '--dump', '-', '--checkpoint-staging'],
      ['--source', 'openlibrary', '--dump-set', join(directory, 'manifest.json'), '--checkpoint-staging'],
    ];
    for (const extra of refused) {
      const result = await runImportCli([...extra, ...credentials], { fetch: blocked });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Checkpointed staging is limited');
    }
    for (const source of ['bangumi', 'wikidata'] as const) {
      const missing = await runImportCli(
        [
          '--source',
          source,
          '--dump',
          join(directory, 'dump.json'),
          ...credentials,
          '--resume-staging',
          '--generation',
          '1',
        ],
        { fetch: blocked },
      );
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('No importer state database');
    }
    expect(requests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checkpointed Wikidata staging resumes the same generation without reconverting the prefix or pre-seal transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-wd-'));
  const dump = wikiDump([wiki(11), wiki(12), wiki(13), wiki(14)]);
  const identity = identityOf(dump);
  const f = fake();
  const controller = new AbortController();
  const first = wrap('wikidata', (n) => {
    if (n === 3) {
      controller.abort(new DOMException('stop', 'AbortError'));
      throw controller.signal.reason;
    }
  });
  const importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: first.observer });
  try {
    const interrupted = await importer.runDump(first.registration, bytes(dump), {
      signal: controller.signal,
      checkpoint: { action: 'acquire', identity },
    });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.checkpointed).toBe(true);
    expect(interrupted.committedPrefix).toBe(2);
    expect(f.requests).toHaveLength(0);
    expect(first.conversions()).toBe(3);
    const stored = importer.session.store.stagingCheckpoint('wikidata', interrupted.runId!);
    expect(stored?.committedOrdinal).toBe(2);
  } finally {
    await importer.close();
  }
  const second = wrap('wikidata', () => {});
  const resumed = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: second.observer });
  try {
    const result = await resumed.runDump(second.registration, bytes(dump), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(result.status).toBe('committed');
    expect(second.conversions()).toBe(2);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(resumed.session.store.stagingCheckpoint('wikidata', '1')).toBeNull();
  } finally {
    await resumed.close();
    rmSync(dir, { recursive: true });
  }
});

test('Open Library checkpoint resume skips committed conversion and ordinary import still discards staging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-ol-'));
  const dump = readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/api/openlibrary.tsv'), 'utf8');
  const identity = identityOf(dump, {
    sourceAlias: 'openlibrary',
    sourceKind: 'openlibrary',
    converterRevision: createSourceRegistration('openlibrary').converter_revision,
  });
  const f = fake();
  const controller = new AbortController();
  const first = wrap('openlibrary', (n) => {
    if (n === 2) {
      controller.abort(new DOMException('stop', 'AbortError'));
      throw controller.signal.reason;
    }
  });
  const importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: first.observer });
  try {
    const interrupted = await importer.runDump(first.registration, bytes(dump), {
      signal: controller.signal,
      checkpoint: { action: 'acquire', identity },
    });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.committedPrefix).toBe(1);
  } finally {
    await importer.close();
  }
  const abandoned = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport });
  try {
    const result = await abandoned.runDump(createSourceRegistration('openlibrary'), bytes(dump));
    expect(result.status).toBe('committed');
    expect(result.runId).not.toBe('1');
  } finally {
    await abandoned.close();
    rmSync(dir, { recursive: true });
  }
});

test('changed bytes, converter, old staging, ready work and prefix tampering never resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-fail-'));
  const dump = wikiDump([wiki(21), wiki(22), wiki(23)]);
  const identity = identityOf(dump);
  const f = fake();
  const controller = new AbortController();
  const first = wrap('wikidata', (n) => {
    if (n === 2) {
      controller.abort(new DOMException('stop', 'AbortError'));
      throw controller.signal.reason;
    }
  });
  const importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: first.observer });
  try {
    const interrupted = await importer.runDump(first.registration, bytes(dump), {
      signal: controller.signal,
      checkpoint: { action: 'acquire', identity },
    });
    expect(interrupted.committedPrefix).toBe(1);
    const changed = identityOf(wikiDump([wiki(21), wiki(22), wiki(99)]));
    const mismatch = await importer.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: { action: 'resume', generation: '1', identity: changed },
    });
    expect(mismatch.status).toBe('invalid-dump');
    expect(mismatch.diagnostic).toBe(STAGING_INCOMPATIBLE);
    expect(importer.session.store.stagingCheckpoint('wikidata', '1')?.committedOrdinal).toBe(1);
    const converter = await importer.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: {
        action: 'resume',
        generation: '1',
        identity: { ...identity, converterRevision: 'other@1' },
      },
    });
    expect(converter.status).toBe('invalid-dump');
    importer.session.store.database
      .prepare('UPDATE run_staging_prefix SET record_key=? WHERE source=? AND run_id=? AND ordinal=1')
      .run('Q999', 'wikidata', '1');
    const tampered = await importer.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(tampered.status).toBe('invalid-dump');
    expect(tampered.diagnostic).toBe(STAGING_INCOMPATIBLE);
  } finally {
    await importer.close();
  }
  const plain = new Importer({ path: `${dir}/plain.sqlite`, transport: f.transport });
  try {
    const run = plain.session.store.begin('wikidata');
    if (run === 'busy') throw 0;
    const resumeOld = await plain.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: { action: 'resume', generation: run.id, identity },
    });
    expect(resumeOld.status).toBe('invalid-dump');
    expect(resumeOld.diagnostic).toBe(STAGING_OLD_UNSUPPORTED);
  } finally {
    await plain.close();
  }
  const stopSeal = new AbortController();
  const sealed = new Importer({
    path: `${dir}/sealed.sqlite`,
    transport: f.transport,
    afterBulkSuccess() {
      stopSeal.abort(new DOMException('after seal', 'AbortError'));
      throw stopSeal.signal.reason;
    },
  });
  try {
    const done = await sealed.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      signal: stopSeal.signal,
      checkpoint: { action: 'acquire', identity },
    });
    expect(['interrupted', 'bulk-failed']).toContain(done.status);
    const again = await sealed.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(again.status).toBe('invalid-dump');
    expect(again.diagnostic).toBe(STAGING_SEALED_RESUME);
  } finally {
    await sealed.close();
    rmSync(dir, { recursive: true });
  }
});

test('duplicate keys across the committed boundary keep invalid-input semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-dup-'));
  const dump = wikiDump([wiki(31), wiki(32), wiki(31)]);
  const identity = identityOf(dump);
  const f = fake();
  const controller = new AbortController();
  const first = wrap('wikidata', (n) => {
    if (n === 2) {
      controller.abort(new DOMException('stop', 'AbortError'));
      throw controller.signal.reason;
    }
  });
  const importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: first.observer });
  try {
    await importer.runDump(first.registration, bytes(dump), {
      signal: controller.signal,
      checkpoint: { action: 'acquire', identity },
    });
    const resumed = await importer.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(resumed.status).toBe('invalid-dump');
    expect(f.requests).toHaveLength(0);
  } finally {
    await importer.close();
    rmSync(dir, { recursive: true });
  }
});

test('empty input seals, truncated suffix stays recoverable, and acquire refuses an active generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-empty-'));
  const empty = '[]\n';
  const identity = identityOf(empty);
  const f = fake();
  const importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport });
  try {
    const committed = await importer.runDump(createSourceRegistration('wikidata'), bytes(empty), {
      checkpoint: { action: 'acquire', identity },
    });
    expect(committed.status).toBe('committed');
    expect(f.requests).toHaveLength(0);
  } finally {
    await importer.close();
  }
  const dump = wikiDump([wiki(41), wiki(42), wiki(43)]);
  const stop = new AbortController();
  const wrapping = wrap('wikidata', (n) => {
    if (n === 2) {
      stop.abort(new DOMException('stop', 'AbortError'));
      throw stop.signal.reason;
    }
  });
  const live = new Importer({ path: `${dir}/live.sqlite`, transport: f.transport, observer: wrapping.observer });
  try {
    await live.runDump(wrapping.registration, bytes(dump), {
      signal: stop.signal,
      checkpoint: { action: 'acquire', identity: identityOf(dump) },
    });
    const truncated = await live.runDump(createSourceRegistration('wikidata'), bytes(dump.slice(0, 40)), {
      checkpoint: { action: 'resume', generation: '1', identity: identityOf(dump) },
    });
    expect(truncated.status).toBe('invalid-dump');
    expect(live.session.store.stagingCheckpoint('wikidata', '1')?.committedOrdinal).toBe(1);
    const busy = await live.runDump(createSourceRegistration('wikidata'), bytes(dump), {
      checkpoint: { action: 'acquire', identity: identityOf(dump) },
    });
    expect(busy.diagnostic).toBe(STAGING_ACTIVE_GENERATION);
  } finally {
    await live.close();
    rmSync(dir, { recursive: true });
  }
});

test('checkpoint rolling digest extends per ordinal and rejects a missing cursor', () => {
  const first = extendPrefixDigest(emptyPrefixDigest(), {
    ordinal: 1,
    recordKey: 'Q1',
    digest: 'a'.repeat(64),
  });
  const second = extendPrefixDigest(first, { ordinal: 2, recordKey: 'Q2', digest: 'b'.repeat(64) });
  expect(first).not.toBe(second);
  const missing = evaluateResume(null, identityOf('[]\n'), {
    status: 'staging',
    prepared: 0,
    pending: false,
    covers: false,
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe('missing');
});

test('resume does not create a missing database and live owners stay busy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-session-'));
  try {
    expect(() => new ImportSession(`${dir}/missing.sqlite`, { create: false })).toThrow();
    const a = new ImportSession(`${dir}/state.sqlite`);
    const b = new ImportSession(`${dir}/state.sqlite`);
    try {
      const own = a.acquire('wikidata');
      if (own === 'busy') throw 0;
      expect(b.acquire('wikidata')).toBe('busy');
      a.release(own);
    } finally {
      a.close();
      b.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
