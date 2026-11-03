import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Importer } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);
const registration = createSourceRegistration('wikidata');
function row(id = 1, title = 'Target', aliases = 0) {
  const r = structuredClone(fixture);
  r.id = `Q${id}`;
  r.labels.en.value = title;
  r.aliases = { en: Array.from({ length: aliases }, (_, i) => ({ language: 'en', value: `Alias ${i}` })) };
  for (const claims of Object.values(r.claims) as any[][])
    for (const c of claims) c.id = c.id.replace(/^Q1\$/, `${r.id}$`);
  return { source: 'wikidata' as const, key: r.id, revision: String(r.lastrevid), payload: r };
}
async function* records(...rows: ReturnType<typeof row>[]) {
  yield* rows;
}
function fake() {
  const receipts = new Map<string, { body: string; result: BatchWriteResult['results'][number] }>();
  const requests: BatchWriteRequest[] = [];
  let fenceCalls = 0;
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      return {
        results: request.commands.map((c) => {
          const prior = receipts.get(c.key);
          if (prior) {
            expect(JSON.stringify(c)).toBe(prior.body);
            return structuredClone(prior.result);
          }
          const result = {
            key: c.key,
            status: 200 as const,
            value:
              c.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : c.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(c.key, { body: JSON.stringify(c), result });
          return result;
        }),
      };
    },
    async readFence() {
      fenceCalls++;
      return { fenced: false, securityRevision: null };
    },
  };
  return {
    transport,
    requests,
    receipts,
    get fenceCalls() {
      return fenceCalls;
    },
  };
}
function directory() {
  return mkdtempSync(join(tmpdir(), 'importer-local-'));
}
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}

test('same-file live owners exclude another connection while independent sources proceed', async () => {
  const dir = directory(),
    f = fake(),
    entered = defer(),
    release = defer();
  let first = true;
  const a = new Importer({
    path: `${dir}/state.sqlite`,
    transport: {
      ...f.transport,
      async batchWrite(r) {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return f.transport.batchWrite(r);
      },
    },
  });
  const b = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport });
  const pending = a.runRecords(registration, records(row()));
  try {
    await entered.promise;
    expect((await b.runRecords(registration, records(row(1, 'Newer')))).status).toBe('busy');
    expect(
      (await b.runRecords(createSourceRegistration('wikidata', { source: 'independent' }), records(row()))).status,
    ).toBe('committed');
  } finally {
    release.resolve();
    expect((await pending).status).toBe('committed');
    await a.close();
    await b.close();
  }
  const reopened = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport });
  try {
    const before = f.requests.length;
    expect((await reopened.runRecords(registration, records(row()))).status).toBe('committed');
    expect(f.requests.length).toBe(before);
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true });
  }
});

test('guard release permits capability rotation and fences old RunStore handles', () => {
  const dir = directory(),
    a = new ImportSession(`${dir}/state.sqlite`),
    b = new ImportSession(`${dir}/state.sqlite`);
  try {
    const own = a.acquire('wikidata');
    if (own === 'busy') throw 0;
    const run = a.store.begin('wikidata');
    if (run === 'busy') throw 0;
    expect(b.acquire('wikidata')).toBe('busy');
    a.release(own);
    const other = b.acquire('wikidata');
    if (other === 'busy') throw 0;
    const reopened = b.reopen(other)!;
    expect(reopened.lease).not.toBe(run.lease);
    expect(() => a.store.seal(run, { complete: true })).toThrow();
    b.store.seal(reopened, { complete: true });
    expect(b.store.finalize(reopened, 1)).toBe('complete');
    b.release(other);
    a.store.database
      .prepare('INSERT INTO import_owners VALUES(?,?,?,?)')
      .run('wikidata', process.pid, 'different-birth', 'old');
    const reused = a.acquire('wikidata');
    expect(reused).not.toBe('busy');
    if (reused !== 'busy') a.release(reused);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true });
  }
});

test('dead process owner recovers immediately with birth identity and no lease timeout', async () => {
  const dir = directory();
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import {ImportSession} from ${JSON.stringify(join(import.meta.dir, '../src/import-session.ts'))};const s=new ImportSession(${JSON.stringify(`${dir}/state.sqlite`)});s.acquire('wikidata');s.store.begin('wikidata');console.log('ready');setInterval(()=>{},1000);`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('ready');
    const session = new ImportSession(`${dir}/state.sqlite`);
    try {
      expect(session.acquire('wikidata')).toBe('busy');
      child.kill(9);
      await child.exited;
      const own = session.acquire('wikidata');
      expect(own).not.toBe('busy');
      if (own !== 'busy') {
        const run = session.reopen(own)!;
        expect(session.store.seal(run, { complete: true }).status).toBe('ready');
        expect(session.store.finalize(run, 1)).toBe('complete');
        session.release(own);
      }
    } finally {
      session.close();
    }
  } finally {
    child.kill(9);
    await child.exited;
    reader.releaseLock();
    rmSync(dir, { recursive: true });
  }
});

test('uncertain run replays original source and command bodies before changed input is consumed', async () => {
  const dir = directory(),
    f = fake();
  let fault = true;
  let importer = new Importer({
    path: `${dir}/state.sqlite`,
    transport: f.transport,
    afterBulkSuccess() {
      if (fault) {
        fault = false;
        throw 0;
      }
    },
  });
  try {
    expect((await importer.runRecords(registration, records(row(1, 'Original')))).status).toBe('interrupted');
    const original = f.requests[0];
    await importer.close();
    importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport });
    let consumed = false;
    const result = await importer.runRecords(
      registration,
      (async function* () {
        consumed = true;
        yield row(1, 'Newer');
      })(),
    );
    expect(result.status).toBe('committed');
    expect(consumed).toBe(false);
    expect(f.requests[1]).toEqual(original);
    expect(JSON.stringify(f.requests)).not.toContain('Newer');
    expect((await importer.runRecords(registration, records(row(1, 'Newer')))).status).toBe('committed');
  } finally {
    await importer.close();
    rmSync(dir, { recursive: true });
  }
});

test('real ignored conversion and vanished record without owned candidates use zero-effect authority', async () => {
  const f = fake(),
    importer = new Importer({ path: ':memory:', transport: f.transport });
  const ignored = (id: number) => {
    const r = row(id);
    r.payload.claims.P31[0].mainsnak.datavalue.value = { id: 'Q571', 'entity-type': 'item', 'numeric-id': 571 };
    return r;
  };
  try {
    expect((await importer.runRecords(registration, records(ignored(1), ignored(2)))).status).toBe('committed');
    expect((await importer.runRecords(registration, records(ignored(1)), { disappearanceThreshold: 1 })).status).toBe(
      'committed',
    );
    expect(importer.session.store.key('wikidata', 'Q2').acknowledged?.state).toBe('vanished');
    expect(f.requests).toHaveLength(0);
    expect(f.fenceCalls).toBe(12);
  } finally {
    await importer.close();
  }
});

test('unfenced media intent cannot acknowledge without resolver, while fenced cover never calls resolver', async () => {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/bangumi/subject.json'), 'utf8'),
  );
  const r = { source: 'bangumi' as const, key: String(raw.id), revision: null, payload: raw };
  const source = createSourceRegistration('bangumi'),
    f = fake();
  const unresolved = new Importer({ path: ':memory:', transport: f.transport });
  try {
    expect(
      (
        await unresolved.runRecords(
          source,
          (async function* () {
            yield r;
          })(),
        )
      ).status,
    ).toBe('interrupted');
    expect(unresolved.session.store.source(source.source).generation).toBeNull();
    expect(unresolved.session.store.key(source.source, r.key).acknowledged).toBeNull();
  } finally {
    await unresolved.close();
  }
  let resolverCalls = 0;
  const fenced = new Importer({
    path: ':memory:',
    transport: {
      ...f.transport,
      async readFence(k) {
        return k.field_group === 'cover'
          ? { fenced: true, securityRevision: '9007199254740993' }
          : { fenced: false, securityRevision: null };
      },
    },
    mediaResolver: {
      async resolve() {
        resolverCalls++;
        return { status: 'pending' };
      },
    },
  });
  try {
    expect(
      (
        await fenced.runRecords(
          source,
          (async function* () {
            yield r;
          })(),
        )
      ).status,
    ).toBe('committed');
    expect(resolverCalls).toBe(0);
  } finally {
    await fenced.close();
  }
});

test('assertHeld and readOwner expose the exact held PID/birth capability', () => {
  const dir = directory();
  const session = new ImportSession(`${dir}/state.sqlite`);
  try {
    const own = session.acquire('wikidata');
    if (own === 'busy') throw new Error('busy');
    session.assertHeld(own);
    const owner = session.readOwner('wikidata');
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.birth).toBeString();
    expect(() => session.assertHeld({ source: 'wikidata', capability: '0'.repeat(48) })).toThrow(
      'Stale import ownership',
    );
    session.release(own);
    expect(session.readOwner('wikidata')).toBeNull();
  } finally {
    session.close();
    rmSync(dir, { recursive: true });
  }
});

test('existing-state open refuses a missing path and peekActive does not rotate a staging lease', async () => {
  const dir = directory();
  try {
    await expect(ImportSession.openExisting(join(dir, 'missing.sqlite'))).rejects.toMatchObject({ kind: 'missing' });
    expect(existsSync(join(dir, 'missing.sqlite'))).toBe(false);
    const created = new ImportSession(`${dir}/state.sqlite`);
    const own = created.acquire('wikidata');
    if (own === 'busy') throw 0;
    const run = created.store.begin('wikidata');
    if (run === 'busy') throw 0;
    const lease = run.lease;
    const peeked = created.peekActive(own);
    expect(peeked?.status).toBe('staging');
    expect(peeked?.run.lease).toBe(lease);
    expect(created.store.activeRun('wikidata')?.lease).toBe(lease);
    created.release(own);
    created.close();
    const reopened = await ImportSession.openExisting(`${dir}/state.sqlite`);
    try {
      const next = reopened.acquire('wikidata');
      if (next === 'busy') throw 0;
      expect(reopened.peekActive(next)?.status).toBe('staging');
      expect(reopened.peekActive(next)?.run.lease).toBe(lease);
      reopened.release(next);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
