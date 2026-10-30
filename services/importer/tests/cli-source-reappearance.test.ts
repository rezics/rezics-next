import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceId, SourceRecord } from '@rezics/conversion';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

// Pure coordinator/SQLite proof with an explicit protocol double. This is not native CLI acceptance.
function record(source: SourceId, index: number, version: number): SourceRecord {
  const n = 930001 + index,
    revision = index === 0 ? version + 6 : 7;
  const title = `Synthetic ${source} ${index} version ${index === 0 ? version : 1}`;
  const key =
    source === 'bangumi' ? String(n) : source === 'vndb' ? `v${n}` : source === 'wikidata' ? `Q${n}` : `/works/OL${n}W`;
  const payload =
    source === 'bangumi'
      ? { id: n, type: 2, name: title }
      : source === 'openlibrary'
        ? { key, type: { key: '/type/work' }, revision, title }
        : source === 'vndb'
          ? {
              vn: { id: key, olang: 'en', c_votecount: 0, c_average: null },
              vn_titles: [{ id: key, lang: 'en', official: true, title, latin: null }],
              entry_meta: { id: key, revision },
            }
          : {
              id: key,
              type: 'item',
              lastrevid: revision,
              labels: { en: { language: 'en', value: title } },
              claims: {
                P31: [
                  {
                    type: 'statement',
                    rank: 'normal',
                    mainsnak: {
                      snaktype: 'value',
                      property: 'P31',
                      datatype: 'wikibase-item',
                      datavalue: {
                        type: 'wikibase-entityid',
                        value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
                      },
                    },
                  },
                ],
              },
            };
  return { source, key, revision: source === 'bangumi' ? null : String(revision), payload };
}

for (const source of ['bangumi', 'vndb', 'openlibrary', 'wikidata'] as const) {
  test(`${source} removed owner reuses its bootstrap, refreshes provenance and honors an absent-time fence`, async () => {
    const directory = await mkdtemp('/dev/shm/reappearance-unit-');
    const path = join(directory, 'state.sqlite');
    const sent: BatchCommand[] = [];
    const receipts = new Map<string, BatchWriteResult['results'][number]>();
    const fences = new Set<string>();
    const transport = {
      async readFence(tuple: { source: string; externalId: string; fieldGroup: string }) {
        const fenced = fences.has(JSON.stringify(tuple));
        return { fenced, securityRevision: fenced ? '1' : null };
      },
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        sent.push(...structuredClone(request.commands));
        return {
          results: request.commands.map((command) => {
            const previous = receipts.get(command.key);
            if (previous) return previous;
            const entry = {
              key: command.key,
              status: 200 as const,
              value:
                command.op === 'create'
                  ? { id: randomUUID(), revision: 1 }
                  : command.op === 'propose'
                    ? { candidate: randomUUID(), revision: 1 }
                    : { revision: 1 },
            };
            receipts.set(command.key, entry);
            return entry;
          }),
        };
      },
    };
    let importer = new Importer({ path, transport });
    const run = (version: number, absent = false, alias: string = source, invalid = false) =>
      importer.runRecords(
        createSourceRegistration(source, { source: alias }),
        (async function* () {
          for (let i = absent ? 1 : 0; i < 5; i++) yield record(source, i, version);
          if (invalid) throw new Error('Synthetic late acquisition failure');
        })(),
      );
    const reopen = async () => {
      await importer.close();
      importer = new Importer({ path, transport });
    };
    try {
      expect((await run(1)).status).toBe('committed');
      expect((await run(1, false, 'independent')).status).toBe('committed');
      const owner = { source, external_id: record(source, 0, 1).key };
      const claim = importer.session.bindings.claim(owner);
      const bootstrap = sent.find(
        (c) => c.op === 'create' && c.source.source === source && c.source.external_id === owner.external_id,
      )!;
      const journal = importer.session.bindings.journal(owner, bootstrap.key);
      const originalReceipts = structuredClone(receipts);
      const original = importer.session.bindings.candidates(owner, 'facts', { limit: 100 });
      expect(original.length).toBeGreaterThan(0);
      const independent = importer.session.store.source('independent');
      const independentClaim = importer.session.bindings.claim({ ...owner, source: 'independent' });
      const beforeInvalid = sent.length;
      expect((await run(2, false, source, true)).status).toBe('invalid-dump');
      expect(sent).toHaveLength(beforeInvalid);
      expect(importer.session.store.source(source).count).toBe(5);
      await reopen();
      expect((await run(1, true)).status).toBe('committed');
      expect(importer.session.store.source(source).count).toBe(4);
      expect(importer.session.bindings.candidates(owner, 'facts', { limit: 100 })).toEqual([]);
      expect(
        sent
          .slice(beforeInvalid)
          .every((c) => c.op === 'retract' && original.some((old) => old.candidate === c.candidate)),
      ).toBe(true);
      await reopen();
      const returnStart = sent.length;
      expect((await run(2)).status).toBe('committed');
      const baseline = importer.session.store.key(source, owner.external_id).baseline!;
      const returned = sent.slice(returnStart);
      expect(returned.length).toBeGreaterThan(0);
      expect(
        returned.every(
          (c) =>
            c.op === 'propose' &&
            c.source.external_id === owner.external_id &&
            c.source.digest === baseline.digest &&
            c.source.record_revision === baseline.recordRevision,
        ),
      ).toBe(true);
      expect(importer.session.bindings.claim(owner)).toEqual(claim);
      expect(importer.session.bindings.journal(owner, bootstrap.key)).toEqual(journal);
      expect((await run(2, true)).status).toBe('committed');
      fences.add(JSON.stringify({ source, externalId: owner.external_id, fieldGroup: 'facts' }));
      await reopen();
      const fencedStart = sent.length;
      expect((await run(3)).status).toBe('committed');
      expect(sent).toHaveLength(fencedStart);
      expect(importer.session.store.source(source).count).toBe(5);
      await reopen();
      expect((await run(3)).status).toBe('committed');
      expect(sent).toHaveLength(fencedStart);
      for (const [key, value] of originalReceipts) expect(receipts.get(key)).toEqual(value);
      expect(importer.session.store.source('independent')).toEqual(independent);
      expect(importer.session.bindings.claim({ ...owner, source: 'independent' })).toEqual(independentClaim);
    } finally {
      await importer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
