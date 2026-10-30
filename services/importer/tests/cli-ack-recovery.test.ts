import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import { ImportSession } from '../src/import-session.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

// Local protocol proof only. Native CLI/Auth/worker acceptance lives in the kernel journey.
for (const source of ['bangumi', 'openlibrary'] as const) {
  test(`${source} recovery drains the sealed envelope before consuming a successor`, async () => {
    const directory = await mkdtemp('/dev/shm/import-ack-unit-');
    const path = join(directory, 'state.sqlite');
    const registration = createSourceRegistration(source, { source });
    const sourceRecord =
      source === 'bangumi'
        ? { id: 424242, type: 2, name: 'Original title' }
        : { key: '/books/OL900000002M', type: { key: '/type/edition' }, revision: 11, title: 'Original title' };
    const externalId = source === 'bangumi' ? '424242' : '/books/OL900000002M';
    const subject = randomUUID();
    const receipts = new Map<string, BatchWriteResult['results'][number]>();
    const sent: string[] = [];
    let lose = true;
    const controller = new AbortController();
    const transport = {
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        sent.push(JSON.stringify(request));
        const results = request.commands.map((command) => {
          const prior = receipts.get(command.key);
          if (prior) return prior;
          const entry = {
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: subject, revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, entry);
          return entry;
        });
        if (lose && request.commands.some((command) => command.op === 'propose')) {
          controller.abort(new DOMException('Local response loss', 'AbortError'));
          throw controller.signal.reason;
        }
        return { results };
      },
    };
    let importer: Importer | undefined;
    try {
      importer = new Importer({ path, transport });
      const interrupted = await importer.runRecords(
        registration,
        (async function* () {
          yield { source, key: externalId, revision: source === 'bangumi' ? null : '11', payload: sourceRecord };
        })(),
        { signal: controller.signal },
      );
      expect(['interrupted', 'bulk-failed']).toContain(interrupted.status);
      await importer.close();
      const session = new ImportSession(path);
      let bytes: string[];
      try {
        const active = session.store.activeRun(source)!;
        bytes = session.store.pagePending(active, { limit: 100 }).map((pending) => pending.bytes);
        expect(bytes).toHaveLength(1);
        expect(session.store.source(source).generation).toBeNull();
      } finally {
        session.close();
      }
      const receiptCount = receipts.size;
      const before = sent.length;
      lose = false;
      importer = new Importer({ path, transport });
      let consumed = 0;
      const resumed = await importer.runRecords(
        registration,
        (async function* () {
          consumed++;
          yield {
            source,
            key: externalId,
            revision: '12',
            payload: { ...sourceRecord, title: 'Newer title', name: 'Newer title' },
          };
        })(),
      );
      expect(resumed.status).toBe('committed');
      expect(sent.slice(before)).toEqual(bytes);
      expect(receipts.size).toBe(receiptCount);
      expect(consumed).toBe(0);
      expect(importer.session.store.activeRun(source)).toBeNull();
      expect(importer.session.store.key(source, externalId).baseline!.recordRevision).toBe(
        source === 'bangumi' ? 'unversioned' : '11',
      );
    } finally {
      await importer?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
