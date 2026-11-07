import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceRecord } from '@rezics/conversion';
import { Importer } from '../src/importer.ts';
import { ImportTransportError } from '../src/import-client.ts';
import { resolveOwnReferences } from '../src/own-references.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import type { SourceProjection } from '../src/run-store.ts';

const projection: SourceProjection = {
  sourceKind: 'openlibrary',
  normalizedRecord: {
    type: { key: '/type/edition' },
    key: '/books/OL2M',
    authors: [{ key: '/authors/OL1A' }],
    works: [{ key: '/works/OL1W' }],
  },
};
const temporary = join(import.meta.dir, '../../../.temp');
function temporaryDirectory(prefix: string): string {
  mkdirSync(temporary, { recursive: true });
  return mkdtempSync(join(temporary, prefix));
}

test('own Open Library handoff point-reads only exact configured aliases and native relation keys', () => {
  const calls: { source: string; external_id: string }[] = [];
  const claims = new Map([
    ['alias-a:/works/OL1W', { state: 'bound' as const, subject: 'real-work-id' }],
    ['alias-b:/authors/OL1A', { state: 'bound' as const, subject: 'other-alias-id' }],
  ]);
  const bindingReader = {
    claim(input: { source: string; external_id: string }) {
      calls.push(input);
      return claims.get(`${input.source}:${input.external_id}`) ?? null;
    },
  };

  const resolved = resolveOwnReferences(projection, 'alias-a', bindingReader);
  expect(resolved?.resolvedReferences).toEqual({ '/works/OL1W': 'real-work-id' });
  expect(calls).toEqual([
    { source: 'alias-a', external_id: '/authors/OL1A' },
    { source: 'alias-a', external_id: '/works/OL1W' },
  ]);
  expect(resolveOwnReferences(projection, 'alias-b', bindingReader)?.resolvedReferences).toEqual({
    '/authors/OL1A': 'other-alias-id',
  });
});

function nativeReceipts(beforeWrite?: (request: BatchWriteRequest) => void | Promise<void>) {
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  const requests: BatchWriteRequest[] = [];
  return {
    requests,
    receipts,
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        requests.push(structuredClone(request));
        await beforeWrite?.(request);
        return {
          results: request.commands.map((command) => {
            const bytes = JSON.stringify(command);
            const prior = receipts.get(command.key);
            if (prior) {
              expect(bytes).toBe(prior.bytes);
              return structuredClone(prior.result);
            }
            const result = {
              key: command.key,
              status: 201 as const,
              value:
                command.op === 'create'
                  ? { id: randomUUID(), revision: 1 }
                  : command.op === 'propose'
                    ? { candidate: randomUUID(), revision: 1 }
                    : { revision: 1 },
            };
            receipts.set(command.key, { bytes, result });
            return result;
          }),
        };
      },
    },
  };
}

const edition: SourceRecord = {
  source: 'openlibrary',
  key: '/books/OL2M',
  revision: '1',
  payload: {
    type: { key: '/type/edition' },
    key: '/books/OL2M',
    revision: 1,
    title: 'Harbor',
    last_modified: { value: '2024-01-02T03:04:05.000000' },
    works: [{ key: '/works/OL1W' }],
    authors: [{ key: '/authors/OL1A' }],
  },
};
const work: SourceRecord = {
  source: 'openlibrary',
  key: '/works/OL1W',
  revision: '7',
  payload: {
    type: { key: '/type/work' },
    key: '/works/OL1W',
    revision: 7,
    title: 'Lantern 🌙',
    last_modified: { value: '2024-01-02T03:04:05.000000' },
  },
};
async function* input(...records: SourceRecord[]) {
  yield* records;
}

test('same-run Work overload yields Edition admission and replays the sealed create after cancellation', async () => {
  const directory = temporaryDirectory('own-reference-overload-');
  const path = join(directory, 'state.sqlite');
  const registration = createSourceRegistration('openlibrary', { source: 'openlibrary-local' });
  let mode: 'exhaust' | 'cancel' | 'ready' = 'exhaust';
  let failures = 0;
  let controller: AbortController | undefined;
  const native = nativeReceipts((request) => {
    if (!request.commands.some((command) => command.op === 'create' && command.source.external_id === work.key)) return;
    if (mode === 'ready') return;
    failures++;
    if (mode === 'cancel' && failures === 2) controller!.abort();
    throw new ImportTransportError(503, undefined, 'semantic_not_ready', true);
  });
  let importer = new Importer({ path, transport: native.transport });
  const workWrites = () =>
    native.requests.filter((request) =>
      request.commands.some((command) => command.op === 'create' && command.source.external_id === work.key),
    );
  try {
    expect((await importer.runRecords(registration, input(edition, work))).status).toBe('bulk-failed');
    expect(failures).toBe(5);
    const sealed = JSON.stringify(workWrites()[0]);
    expect(workWrites().every((request) => JSON.stringify(request) === sealed)).toBe(true);
    expect(workWrites()[0]!.commands[0]!.source.record_revision).toBe('7');
    expect(workWrites()[0]!.commands[0]!.source.converter_revision).toBe('open-library@5');
    expect(importer.session.bindings.claim({ source: registration.source, external_id: work.key })?.state).not.toBe(
      'bound',
    );
    expect(importer.session.store.key(registration.source, work.key).acknowledged).toBeNull();
    expect(native.requests.some((request) => request.commands.some((command) => command.source.external_id === edition.key))).toBe(
      false,
    );
    const failedImporter = importer;
    await importer.close();
    expect(() => failedImporter.session.store.database.query('SELECT 1').get()).toThrow();

    mode = 'cancel';
    failures = 0;
    controller = new AbortController();
    importer = new Importer({ path, transport: native.transport, existing: true });
    expect((await importer.resumeExisting(registration, { signal: controller.signal })).status).toBe('interrupted');
    expect(failures).toBe(2);
    const cancelledImporter = importer;
    await importer.close();
    expect(() => cancelledImporter.session.store.database.query('SELECT 1').get()).toThrow();

    mode = 'ready';
    importer = new Importer({ path, transport: native.transport, existing: true });
    expect((await importer.resumeExisting(registration)).status).toBe('committed');
    expect(workWrites().every((request) => JSON.stringify(request) === sealed)).toBe(true);
    const workCreate = workWrites()[0]!.commands.find(
      (command): command is Extract<BatchCommand, { op: 'create' }> => command.op === 'create',
    )!;
    expect(workCreate.subject).toMatchObject({ type: 'schema:Book', labels: { und: 'Lantern 🌙' } });
    expect(new Set(workWrites().map((request) => request.commands[0]!.key))).toEqual(new Set([workCreate.key]));
    const binding = importer.session.bindings.claim({ source: registration.source, external_id: work.key });
    expect(binding?.state).toBe('bound');
    if (binding?.state !== 'bound') throw new Error('Recovered Work create did not retain its public subject ID');
    expect(native.receipts.get(workCreate.key)?.result).toMatchObject({
      key: workCreate.key,
      status: 201,
      value: { id: binding.subject },
    });
    expect(
      native.requests
        .flatMap((request) => request.commands)
        .filter((command) => command.op === 'create' && command.source.external_id === edition.key),
    ).toHaveLength(1);
    const relation = native.requests.flatMap((request) => request.commands).find(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' &&
        command.source.external_id === edition.key &&
        command.statement.property.id === 'schema:exampleOfWork',
    );
    expect(relation?.op === 'propose' && relation.statement.value).toMatchObject({ type: 'value', content: binding.subject });
  } finally {
    await importer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default own-reference refresh survives reopen without rewriting bootstrap identity or its public receipt', async () => {
  const directory = temporaryDirectory('own-reference-refresh-');
  const path = join(directory, 'state.sqlite');
  const registration = createSourceRegistration('openlibrary', { source: 'openlibrary-local' });
  const native = nativeReceipts();
  const first = new Importer({ path, transport: native.transport });
  let bootstrap: BatchCommand | undefined;
  let initialRow: { bytes: string; result: BatchWriteResult['results'][number] } | undefined;
  try {
    expect((await first.runRecords(registration, input(edition))).status).toBe('committed');
    bootstrap = native.requests
      .flatMap((request) => request.commands)
      .find((command) => command.op === 'create' && command.source.external_id === edition.key);
    expect(bootstrap).toBeDefined();
    initialRow = structuredClone(native.receipts.get(bootstrap!.key));
    expect(initialRow).toBeDefined();
  } finally {
    await first.close();
  }

  const reopened = new Importer({ path, transport: native.transport });
  try {
    expect((await reopened.runRecords(registration, input(work, edition))).status).toBe('committed');
    const ownWork = reopened.session.bindings.claim({ source: registration.source, external_id: work.key });
    expect(ownWork?.state).toBe('bound');
    if (ownWork?.state !== 'bound') throw new Error('Work create did not retain its public subject ID');

    expect((await reopened.runRecords(registration, input(edition, work))).status).toBe('committed');
    const proposals = native.requests
      .flatMap((request) => request.commands)
      .filter(
        (command): command is Extract<BatchCommand, { op: 'propose' }> =>
          command.op === 'propose' && command.source.external_id === edition.key,
      );
    const resolved = proposals.find(
      (command) =>
        command.statement.property.id === 'schema:exampleOfWork' &&
        command.statement.value.type === 'value' &&
        command.statement.value.content === ownWork.subject,
    );
    expect(resolved).toBeDefined();
    expect(resolved!.key).not.toBe(
      proposals.find((command) => command.statement.property.id === 'schema:exampleOfWork')?.key,
    );
    expect(native.receipts.get(bootstrap!.key)).toEqual(initialRow);

    const before = native.requests.length;
    expect((await reopened.runRecords(registration, input(edition, work))).status).toBe('committed');
    expect(native.requests.length).toBe(before);
    expect(native.receipts.get(bootstrap!.key)).toEqual(initialRow);
    expect(
      native.requests.flatMap((request) => request.commands).filter((command) => command.key === bootstrap!.key),
    ).toEqual([bootstrap!]);
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a vanished named Open Library record retracts its own candidates without resolving a missing projection', async () => {
  const directory = temporaryDirectory('own-reference-vanished-');
  const native = nativeReceipts();
  const importer = new Importer({ path: join(directory, 'state.sqlite'), transport: native.transport });
  const a = createSourceRegistration('openlibrary', { source: 'books-a' });
  const b = createSourceRegistration('openlibrary', { source: 'books-b' });
  const second: SourceRecord = {
    ...work,
    key: '/works/OL3W',
    payload: { ...(work.payload as object), key: '/works/OL3W', title: 'Independent retained work' },
  };
  try {
    expect((await importer.runRecords(a, input(work, second))).status).toBe('committed');
    expect((await importer.runRecords(b, input(work, second))).status).toBe('committed');
    const beforeB = importer.session.store.source(b.source);
    const rowB = importer.session.store.key(b.source, work.key);
    const ownA = importer.session.bindings.claim({ source: a.source, external_id: work.key });
    const ownB = importer.session.bindings.claim({ source: b.source, external_id: work.key });
    expect(ownA?.state).toBe('bound');
    expect(ownB?.state).toBe('bound');
    expect(ownA).not.toEqual(ownB);
    const start = native.requests.length;
    const vanished = await importer.runRecords(a, input(second), { disappearanceThreshold: 1 });
    expect(vanished.status).toBe('committed');
    expect(vanished.counts.vanished).toBe(1);
    const retractions = native.requests.slice(start).flatMap((r) => r.commands);
    expect(retractions.length).toBeGreaterThan(0);
    for (const command of retractions) {
      expect(command.op).toBe('retract');
      expect(command.source.source).toBe(a.source);
      expect(command.source.external_id).toBe(work.key);
      if (command.op === 'retract' && ownA?.state === 'bound') expect(command.subject).toBe(ownA.subject);
    }
    expect(importer.session.store.source(b.source)).toEqual(beforeB);
    expect(importer.session.store.key(b.source, work.key)).toEqual(rowB);
    expect(importer.session.bindings.claim({ source: b.source, external_id: work.key })).toEqual(ownB);
    expect(
      importer.session.bindings.candidates({ source: a.source, external_id: work.key }, 'facts', { limit: 100 }),
    ).toEqual([]);
    expect(
      importer.session.bindings.candidates({ source: b.source, external_id: work.key }, 'facts', { limit: 100 }).length,
    ).toBeGreaterThan(0);
  } finally {
    await importer.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
