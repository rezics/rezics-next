import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
} from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const centimeter = 'http://www.wikidata.org/entity/Q174728';
const kilogram = 'http://www.wikidata.org/entity/Q11570';
const charsHeader =
  'id\timage\tbloodt\tcup_size\tsex\tspoil_sex\tgender\tspoil_gender\tmain\tmain_spoil\ts_bust\ts_waist\ts_hip\tbirthday\theight\tweight\tage\tdescription';

function charsLine(id: string, height: string, weight: string) {
  return `${id}\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t0\t\\N\t\\N\t\\N\t\\N\t${height}\t${weight}\t\\N\t\\N`;
}

async function authoredDump(directory: string, heroine = { height: '157', weight: '48' }) {
  const bangumi = join(directory, 'bangumi');
  const vndb = join(directory, 'vndb', 'db');
  await mkdir(bangumi, { recursive: true });
  await mkdir(vndb, { recursive: true });
  await writeFile(
    join(bangumi, 'subject.jsonlines'),
    [
      JSON.stringify({ id: 1, type: 2, name: 'STEINS;GATE' }),
      JSON.stringify({ id: 2, type: 2, name: 'CLANNAD' }),
      JSON.stringify({ id: 3, type: 2, name: 'Fate/stay night' }),
    ].join('\n') + '\n',
  );
  for (const name of [
    'subject-relations',
    'subject-characters',
    'person-characters',
    'episode',
    'person',
    'character',
    'subject-persons',
    'person-relations',
  ])
    await writeFile(join(bangumi, `${name}.jsonlines`), '');
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\talias', 'v1\tja\t\\N\nv2\tja\t\\N\nv3\tja\t\\N'],
    vn_titles: [
      'id\tlang\tofficial\ttitle\tlatin',
      'v1\tja\tt\tSTEINS;GATE\t\\N\nv2\tja\tt\tCLANNAD\t\\N\nv3\tja\tt\tFate/stay night\t\\N',
    ],
    entry_meta: [
      'id\trevision\tlastmod',
      'v1\t1\t2026-10-25 00:00:00+00\nv2\t1\t2026-10-25 00:00:00+00\nv3\t1\t2026-10-25 00:00:00+00',
    ],
    chars: [
      charsHeader,
      `${charsLine('c1', heroine.height, heroine.weight)}\n${charsLine('c2', '161', '52')}\n${charsLine('c3', '0', '\\N')}`,
    ],
    chars_vns: ['id\tvid\trid\trole\tspoil', 'c1\tv1\t\\N\tmain\t0\nc2\tv1\t\\N\tside\t0\nc3\tv1\t\\N\tside\t0'],
    producers_relations: ['id\tpid\trelation', ''],
  };
  for (const name of [
    'anime',
    'extlinks',
    'producers',
    'releases',
    'releases_producers',
    'releases_supersedes',
    'releases_titles',
    'releases_vn',
    'staff',
    'staff_alias',
    'staff_extlinks',
    'vn_anime',
    'vn_extlinks',
    'vn_relations',
    'vn_seiyuu',
    'vn_staff',
  ])
    files[name] ??= ['id', ''];
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(vndb, `${name}.header`), `${header}\n`);
    await writeFile(join(vndb, name), body ? `${body}\n` : '');
  }
  return new CrossMediaDumpFiles(bangumi, join(directory, 'vndb'));
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  source?: unknown;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred'; references?: unknown[] };
};

test('production operator imports authored VNDB character measurements through ordinary accept and current reads', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-measurements-native-'));
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const path = join(directory, 'state.sqlite');
    const first = await seedCrossMedia(
      await planCrossMediaSeed(await authoredDump(directory)),
      path,
      runtime.importTransport,
      {
        origin: 'https://kernel.import.test',
      },
    );
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const subjectId = (row: (typeof first.readings)[number] | undefined) =>
      (row?.subject as { subject?: { id: string } }).subject?.id ?? (row?.subject as { id?: string }).id;
    const heroineId = subjectId(first.readings.find((row) => row.externalId === 'c1'));
    const sideId = subjectId(first.readings.find((row) => row.externalId === 'c2'));
    const unknownId = subjectId(first.readings.find((row) => row.externalId === 'c3'));
    expect(heroineId && sideId && unknownId).toBeTruthy();
    expect(new Set([heroineId, sideId, unknownId]).size).toBe(3);
    async function acceptAdopt(subject: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.source) ?? listing.candidates[0]!;
      const accepted = await editor.http(`/v1/subjects/${subject}/candidates/${candidate.id}:accept`, {
        context: globalContext,
        expected_head: candidate.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subject}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
    }
    await acceptAdopt(heroineId!, 'schema:height');
    await acceptAdopt(heroineId!, 'schema:weight');
    await acceptAdopt(sideId!, 'schema:height');
    await acceptAdopt(sideId!, 'schema:weight');
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          type: string;
          statements: Record<string, { value: { content: unknown }; references?: unknown[] }[]>;
        };
      };
    };
    const heroine = await read(heroineId!);
    expect(heroine.subject.type).toBe('wd:Q95074');
    expect(heroine.subject.statements['schema:height']?.[0]?.value.content).toEqual({
      amount: '+157',
      unit: centimeter,
    });
    expect(heroine.subject.statements['schema:weight']?.[0]?.value.content).toEqual({
      amount: '+48',
      unit: kilogram,
    });
    expect(JSON.stringify(heroine.subject.statements['schema:height']?.[0]?.references)).toContain(
      'https://vndb.org/c1',
    );
    const side = await read(sideId!);
    expect(side.subject.statements['schema:height']?.[0]?.value.content).toEqual({
      amount: '+161',
      unit: centimeter,
    });
    const unknown = await read(unknownId!);
    expect(unknown.subject.statements['schema:height'] ?? []).toEqual([]);
    expect(unknown.subject.statements['schema:weight'] ?? []).toEqual([]);
    const again = await seedCrossMedia(
      await planCrossMediaSeed(await authoredDump(directory)),
      path,
      runtime.importTransport,
      {
        origin: 'https://kernel.import.test',
      },
    );
    expect(
      again.readings.find((row) => row.externalId === 'c1') &&
        subjectId(again.readings.find((row) => row.externalId === 'c1')),
    ).toBe(heroineId);
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const refreshed = join(directory, 'refresh');
    await seedCrossMedia(
      await planCrossMediaSeed(await authoredDump(refreshed, { height: '158', weight: '48' })),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
    );
    const heights = await editor.http(
      `/v1/subjects/${heroineId}/candidates?${new URLSearchParams({ property: 'schema:height', context: globalContext, limit: '100' })}`,
    );
    const amounts = (heights.body as { candidates: Candidate[] }).candidates.map(
      (item) => (item.statement.value.content as { amount?: string }).amount,
    );
    expect(amounts).toEqual(expect.arrayContaining(['+157', '+158']));
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'c1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    const blocked = join(directory, 'fenced');
    await seedCrossMedia(
      await planCrossMediaSeed(await authoredDump(blocked, { height: '159', weight: '49' })),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
    );
    const fenced = await editor.http(
      `/v1/subjects/${heroineId}/candidates?${new URLSearchParams({ property: 'schema:height', context: globalContext, limit: '100' })}`,
    );
    expect(
      (fenced.body as { candidates: Candidate[] }).candidates.some(
        (item) => (item.statement.value.content as { amount?: string }).amount === '+159',
      ),
    ).toBe(false);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
