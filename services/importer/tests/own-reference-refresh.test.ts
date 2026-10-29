import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceRecord } from '@rezics/conversion';
import { Importer } from '../src/importer.ts';
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

function nativeReceipts() {
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  const requests: BatchWriteRequest[] = [];
  return {
    requests,
    receipts,
    transport: {
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        requests.push(structuredClone(request));
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
    type: { key: '/type/edition' }, key: '/books/OL2M', revision: 1,
    title: 'Harbor', last_modified: { value: '2024-01-02T03:04:05.000000' },
    works: [{ key: '/works/OL1W' }], authors: [{ key: '/authors/OL1A' }],
  },
};
const work: SourceRecord = {
  source: 'openlibrary',
  key: '/works/OL1W',
  revision: '1',
  payload: {
    type: { key: '/type/work' }, key: '/works/OL1W', revision: 1,
    title: 'Lantern', last_modified: { value: '2024-01-02T03:04:05.000000' },
  },
};
async function* input(...records: SourceRecord[]) {
  yield* records;
}

test('default own-reference refresh survives reopen without rewriting bootstrap identity or its public receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'own-reference-refresh-'));
  const path = join(directory, 'state.sqlite');
  const registration = createSourceRegistration('openlibrary', { source: 'openlibrary-local' });
  const native = nativeReceipts();
  const first = new Importer({ path, transport: native.transport });
  let bootstrap: BatchCommand | undefined;
  let initialRow: { bytes: string; result: BatchWriteResult['results'][number] } | undefined;
  try {
    expect((await first.runRecords(registration, input(edition))).status).toBe('committed');
    bootstrap = native.requests.flatMap((request) => request.commands).find(
      (command) => command.op === 'create' && command.source.external_id === edition.key,
    );
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
    const proposals = native.requests.flatMap((request) => request.commands).filter(
      (command) => command.op === 'propose' && command.source.external_id === edition.key,
    );
    const resolved = proposals.find(
      (command) => command.statement.property.id === 'schema:exampleOfWork' &&
        command.statement.value.type === 'value' && command.statement.value.content === ownWork.subject,
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
    expect(native.requests.flatMap((request) => request.commands).filter((command) => command.key === bootstrap!.key))
      .toEqual([bootstrap]);
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
