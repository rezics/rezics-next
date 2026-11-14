import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { seedDevelopmentShowcase, type ShowcaseRequest } from '../src/showcase-persona.ts';
import { ShowcaseJournal } from '../src/showcase-journal.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const subjectId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const identityRow = (rank: string, content: string) => ({ rank, value: { type: 'value', content } });

function selectedTables(): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield { id: 10380, type: 2, name: 'STEINS;GATE' };
      else if (provider === 'vndb' && table === 'vn_titles')
        yield* [
          { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
          { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
        ];
      else if (provider === 'vndb' && table === 'vn')
        yield* [
          { id: 'v1', olang: 'ja', alias: null },
          { id: 'v2', olang: 'ja', alias: null },
        ];
      else if (provider === 'vndb' && table === 'entry_meta')
        yield* [
          { id: 'v1', revision: '1', lastmod: '2026-11-04 00:00:00+00' },
          { id: 'v2', revision: '1', lastmod: '2026-11-04 00:00:00+00' },
        ];
    },
  };
}

test('unchanged seed rereads Work identities and restores the same bindings after deprecated-only evidence', async () => {
  await mkdir(join(process.cwd(), '.temp'), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.temp/selected-seed-identities-'));
  const sourceIds = new Map<string, string>();
  const reads = new Map<string, { subject: { id: string; type: string; statements: Record<string, unknown[]> } }>();
  const commands: BatchCommand[] = [];
  let restoreV1 = false;
  let nextSubject = 100;
  const metadata = sourceRecordMetadataFixture();
  const port: CrossMediaPort = {
    async batch(request) {
      commands.push(...structuredClone(request.commands));
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const externalId = command.source.external_id;
            const id = sourceIds.get(externalId) ?? subjectId(++nextSubject);
            sourceIds.set(externalId, id);
            const property = command.source.source === crossMediaAliases.bangumi ? 'wdt:P5732' : 'wdt:P3180';
            const value = externalId;
            const rows =
              externalId === 'v1' && !restoreV1
                ? [identityRow('deprecated', externalId)]
                : [
                    ...(externalId === 'v1' ? [identityRow('deprecated', 'v0')] : []),
                    identityRow(externalId === 'v2' ? 'preferred' : 'normal', value),
                  ];
            reads.set(id, {
              subject: { id, type: command.subject.type, statements: { [property]: rows } },
            });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          return {
            key: command.key,
            status: 201 as const,
            value: command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 },
          };
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return (reads.get(id) ?? { subject: { id, type: 'unknown', statements: {} } }) as ReviewedSubjectRead;
    },
  };

  try {
    const plan = await planCrossMediaSeed(selectedTables(), {
      selection: { bangumi: [10380], vndb: ['v1', 'v2'] },
    });
    const state = join(directory, 'seed.sqlite');
    const extras = { providers: ['bangumi', 'vndb'] as const, mediaDeadlineMs: 0 };
    const first = await seedCrossMedia(plan, state, port, undefined, extras);
    expect(first.readings.filter((row) => row.source === 'vndb').map((row) => row.externalId)).toEqual(['v2']);
    expect(first.gaps).toContainEqual(
      expect.objectContaining({ property: 'wdt:P3180', record: { external_id: 'v1' } }),
    );
    expect(first.readings.some((row) => row.externalId === '10380')).toBe(true);
    const writeCount = commands.length;

    restoreV1 = true;
    const v1Subject = reads.get(sourceIds.get('v1')!)!;
    v1Subject.subject.statements['wdt:P3180'] = [
      { rank: 'deprecated', value: { type: 'value', content: 'v0' } },
      { rank: 'normal', value: { type: 'value', content: 'v1' } },
    ];
    const reopened = await seedCrossMedia(plan, state, port, undefined, extras);
    expect(reopened.readings.filter((row) => row.source === 'vndb').map((row) => row.externalId)).toEqual(['v1', 'v2']);
    expect(reopened.gaps.some((row) => row.record.external_id === 'v1' && row.property === 'wdt:P3180')).toBe(false);
    expect(commands).toHaveLength(writeCount);

    const publicReads: string[] = [];
    const request: ShowcaseRequest = async ({ path }) => {
      publicReads.push(path);
      const requestedId = path.split('/')[3]!.split('?')[0]!;
      const externalId = [...sourceIds].find(([, id]) => id === requestedId)![0];
      const rows =
        externalId === 'v1'
          ? [{ rank: 'deprecated', value: { type: 'value', content: 'v1' } }]
          : [
              { rank: 'deprecated', value: { type: 'value', content: 'v0' } },
              { rank: 'preferred', value: { type: 'value', content: 'v2' } },
            ];
      return Response.json({
        subject: {
          id: externalId === 'v2' ? subjectId(999) : requestedId,
          type: 'wd:Q689445',
          statements: { 'wdt:P3180': rows },
        },
      });
    };
    const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    try {
      const collections = await seedDevelopmentShowcase({
        result: reopened,
        selection: { vndb: ['v1', 'v2'], bangumi: [] },
        journal,
        accountId: subjectId(9999),
        request,
      });
      expect(collections.sources.map((row) => row.status)).toEqual(['missing-source', 'current']);
      expect(collections.sources[1]).toMatchObject({ externalId: 'v2', value: { subjectId: subjectId(999) } });
      expect(publicReads).toHaveLength(2);
      expect(
        collections.collections.filter((row) => row.view !== 'grid').every((row) => row.status === 'missing-source'),
      ).toBe(true);
    } finally {
      journal.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
