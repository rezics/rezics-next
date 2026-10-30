import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

test('source-only Bangumi change publishes fresh digest without inventing a field or native revision', async () => {
  const sent: BatchWriteRequest[] = [];
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  let fenced = false;
  const importer = new Importer({
    path: ':memory:',
    transport: {
      async readFence(tuple) {
        return fenced && tuple.field_group === 'facts'
          ? { fenced: true, securityRevision: '1' }
          : { fenced: false, securityRevision: null };
      },
      async batchWrite(request): Promise<BatchWriteResult> {
        sent.push(structuredClone(request));
        return {
          results: request.commands.map((command) => {
            const old = receipts.get(command.key);
            if (old) {
              expect(JSON.stringify(command)).toBe(old.bytes);
              return old.result;
            }
            const result: BatchWriteResult['results'][number] =
              command.op === 'create'
                ? { key: command.key, status: 201, value: { id: randomUUID(), revision: 1 } }
                : command.op === 'propose'
                  ? { key: command.key, status: 201, value: { candidate: randomUUID(), revision: 1 } }
                  : { key: command.key, status: 200, value: { revision: 1 } };
            receipts.set(command.key, { bytes: JSON.stringify(command), result });
            return result;
          }),
        };
      },
    },
  });
  const registration = createSourceRegistration('bangumi');
  const owner = { source: 'bangumi', external_id: '1' };
  const run = (date: string, privateText = 'ignored') =>
    importer.runDump(
      registration,
      (async function* () {
        yield new TextEncoder().encode(
          JSON.stringify({ id: 1, type: 1, name: 'Same Book', date, user_posts: [{ text: privateText }] }) + '\n',
        );
      })(),
    );
  try {
    expect((await run('2000-01-01')).status).toBe('committed');
    const before = importer.session.store.key('bangumi', '1').baseline;
    if (!before) throw new Error('Missing original baseline');
    const claim = importer.session.bindings.claim(owner);
    const oldRequests = structuredClone(sent);
    const oldReceipts = structuredClone([...receipts]);
    const offset = sent.length;
    const changed = await run('2001-01-01');
    expect(changed.status).toBe('committed');
    expect(changed.counts.changed).toBe(1);
    const after = importer.session.store.key('bangumi', '1').baseline;
    if (!after) throw new Error('Missing refreshed baseline');
    expect(after.digest).not.toBe(before.digest);
    expect(after.recordRevision).toBe('unversioned');
    expect(after.converter_revision).toBe('bangumi@3');
    expect(importer.session.bindings.claim(owner)).toEqual(claim);
    const fresh = sent
      .slice(offset)
      .flatMap((request) => request.commands)
      .filter((command) => command.op === 'propose');
    expect(fresh).toHaveLength(2);
    expect(fresh.every((command) => command.source.digest === after.digest)).toBe(true);
    expect(fresh.map((command) => command.statement.property.id).sort()).toEqual(['schema:name', 'wdt:P5732']);
    expect(sent.flatMap((request) => request.commands).filter((command) => command.op === 'create')).toHaveLength(1);
    expect(sent.slice(0, offset)).toEqual(oldRequests);
    for (const [key, value] of oldReceipts) expect(receipts.get(key)).toEqual(value);
    const noWrites = sent.length;
    expect((await run('2001-01-01', 'different ignored post')).status).toBe('committed');
    expect(sent).toHaveLength(noWrites);
    fenced = true;
    expect((await run('2002-01-01')).status).toBe('committed');
    expect(sent).toHaveLength(noWrites);
  } finally {
    await importer.close();
  }
});
