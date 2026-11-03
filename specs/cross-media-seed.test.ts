import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  crossMediaFranchise,
  decodeCrossMediaCopy,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../services/importer/src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from '../services/importer/tests/transport-driver.ts';

// Synthetic dump-shaped rows exercise the selector; these are not a licensed real-dump product proof.
function tables() {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [i, name] of ['STEINS;GATE', 'CLANNAD', 'Fate/stay night'].entries()) {
    (rows['bangumi/subject'] ??= []).push({ id: i + 1, type: 2, name });
    (rows['vndb/vn_titles'] ??= []).push({ id: `v${i + 1}`, lang: 'ja', official: 't', title: name, latin: null });
    (rows['vndb/vn'] ??= []).push({ id: `v${i + 1}`, olang: 'ja', alias: null });
    (rows['vndb/entry_meta'] ??= []).push({ id: `v${i + 1}`, revision: '1', lastmod: '2026-10-25 00:00:00+00' });
  }
  rows['bangumi/subject']!.push({ id: 4, type: 2, name: 'After Story Extra' });
  rows['bangumi/subject']!.push({ id: 99, type: 2, name: 'Unrelated', summary: 'A CLANNAD fan' });
  rows['bangumi/subject-relations'] = [
    { subject_id: 2, related_subject_id: 4, relation_type: 3, order: 1 },
    { subject_id: 1, related_subject_id: 99, relation_type: 1002, order: 2 },
  ];
  rows['bangumi/subject-characters'] = [
    { subject_id: 1, character_id: 7, type: 1, order: 0 },
    { subject_id: 99, character_id: 7, type: 3, order: 5 },
  ];
  rows['bangumi/person-characters'] = [{ subject_id: 99, character_id: 7, person_id: 8, summary: 'voice' }];
  rows['bangumi/person'] = [{ id: 8, name: 'Actor', type: 1 }];
  rows['bangumi/character'] = [{ id: 7, name: 'Character' }];
  rows['bangumi/subject-persons'] = [{ subject_id: 1, person_id: 8, position: 1, appear_eps: '1-3' }];
  rows['bangumi/episode'] = [{ subject_id: 1, id: 10, sort: 1, type: 0, name: 'Episode' }];
  rows['vndb/vn_staff'] = [{ id: 'v1', aid: '2', role: 'scenario' }];
  rows['vndb/vn_seiyuu'] = [{ id: 'v1', aid: '2', cid: 'c3', note: 'route' }];
  rows['vndb/chars_vns'] = [
    { id: 'c3', vid: 'v1', role: 'main' },
    { id: 'c3', vid: 'v99', role: 'side' },
  ];
  rows['vndb/staff_alias'] = [{ id: 's4', aid: '2', name: 'Actor' }];
  rows['vndb/staff'] = [{ id: 's4', main: '2', prod: null }];
  rows['vndb/chars'] = [{ id: 'c3', main: null, name: 'Character' }];
  rows['vndb/vn_anime'] = [{ id: 'v1', aid: '123' }];
  const input: CrossMediaTables = {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
  return { rows, input };
}

test('three anime/VN franchises elect family membership and retain exact unsupported source fields', async () => {
  const f = tables(),
    plan = await planCrossMediaSeed(f.input);
  expect(plan.records.bangumi.map((r) => r.key)).toEqual(['1', '2', '3', '4']);
  expect(plan.records.vndb.map((r) => r.key)).toEqual(['v1', 'v2', 'v3']);
  expect(plan.entities.bangumi.map((r) => r.key).sort()).toEqual(['character:7', 'episode:10', 'person:8']);
  expect(plan.entities.vndb.map((r) => r.key).sort()).toEqual(['c3', 's4']);
  expect(plan.franchises.clannad.bangumi).toEqual(['2', '4']);
  expect(plan.edges.some((edge) => edge.property === 'wdt:P155' && edge.holder === '4' && edge.target === '2')).toBe(true);
  expect(plan.edges.some((edge) => edge.property === 'schema:character' && edge.target === 'character:7')).toBe(true);
  expect(plan.edges.some((edge) => edge.property === 'wdt:P725')).toBe(true);
  expect(plan.edges.some((edge) => edge.property === 'schema:author' && edge.target === 'person:8')).toBe(true);
  expect(plan.gaps.some((gap) => gap.fields.includes('subject-relations.relation_type') && gap.record.relation_type === 1002)).toBe(
    true,
  );
  expect(plan.gaps.some((gap) => gap.fields.includes('chars_vns.vid') && gap.record.vid === 'v99')).toBe(true);
  expect(plan.gaps.find((gap) => gap.fields.includes('vn_anime.aid'))?.reason).toContain('AniDB');
  expect(plan.gaps.some((gap) => gap.reason.includes('Concept binding'))).toBe(true);
  expect(await planCrossMediaSeed(f.input)).toEqual(plan);
  expect(crossMediaFranchise('A CLANNAD fan')).toBeUndefined();
  delete f.rows['vndb/vn_titles']![0];
  f.rows['vndb/vn_titles'] = f.rows['vndb/vn_titles']!.filter(Boolean);
  await expect(planCrossMediaSeed(f.input)).rejects.toThrow('Missing anime/VN pair');
});

test('dump input decodes PostgreSQL COPY without SQL execution and refuses changing source bytes', async () => {
  await mkdir('.temp', { recursive: true });
  const dir = await mkdtemp('.temp/cross-media-reader-');
  try {
    await mkdir(join(dir, 'db'));
    await writeFile(join(dir, 'db/vn.header'), 'id\talias\timage\n');
    await writeFile(join(dir, 'db/vn'), 'v1\tTitle\\tAlias\\nLine\\134\\101\t\\N\n');
    const input = new CrossMediaDumpFiles(dir, dir);
    const rows = await Array.fromAsync(input.rows('vndb', 'vn'));
    expect(rows).toEqual([{ id: 'v1', alias: 'Title\tAlias\nLine\\A', image: null }]);
    expect(decodeCrossMediaCopy('\\x41')).toBe('A');
    await writeFile(join(dir, 'db/vn'), 'v2\tOther\t\\N\n');
    await expect(Array.fromAsync(input.rows('vndb', 'vn'))).rejects.toThrow('Dump changed');
    await expect(Array.fromAsync(input.rows('bangumi', 'subject'))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the registered importer reopens idempotently and returns only readings supplied by its API port', async () => {
  await mkdir('.temp', { recursive: true });
  const dir = await mkdtemp('.temp/cross-media-run-');
  const metadata = sourceRecordMetadataFixture(),
    effects: string[] = [],
    reads: string[] = [];
  const port: CrossMediaPort = {
    async batch(request) {
      effects.push(...request.commands.map((command) => command.source.source));
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      reads.push(id);
      return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
  try {
    const plan = await planCrossMediaSeed(tables().input);
    const first = await seedCrossMedia(plan, join(dir, 'state.sqlite'), port),
      count = effects.length;
    expect(new Set(effects)).toEqual(new Set(Object.values(crossMediaAliases)));
    const again = await seedCrossMedia(plan, join(dir, 'state.sqlite'), port);
    expect(effects).toHaveLength(count);
    expect(again.runs.bangumi?.counts.unchanged).toBe(7);
    expect(again.runs.vndb?.counts.unchanged).toBe(5);
    expect(again.readings).toEqual(first.readings);
    expect(again.readings.some((row) => row.externalId === 'character:7' && row.route.startsWith('/subjects/'))).toBe(true);
    expect(reads.length).toBe(first.readings.length * 2);
    expect(again.status).toBe('imported-with-gaps');
    expect(again.unresolved.some((edge) => edge.target === 'character:7' || edge.holder === '99')).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
