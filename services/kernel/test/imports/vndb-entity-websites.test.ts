import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrossMediaDumpFiles, planCrossMediaSeed, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
  };
  source?: unknown;
};

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredDump(directory: string, staffSecond = 'https://example.org/staff') {
  const bangumi = join(directory, 'bangumi');
  const db = join(directory, 'db');
  await mkdir(bangumi, { recursive: true });
  await mkdir(db, { recursive: true });
  await writeFile(
    join(bangumi, 'subject.jsonlines'),
    [
      '{"id":1,"type":2,"name":"STEINS;GATE"}',
      '{"id":2,"type":2,"name":"CLANNAD"}',
      '{"id":3,"type":2,"name":"Fate/stay night"}',
    ].join('\n') + '\n',
  );
  for (const table of [
    'subject-relations',
    'subject-characters',
    'subject-persons',
    'person-characters',
    'person-relations',
    'character',
    'person',
    'episode',
  ])
    await writeFile(join(bangumi, `${table}.jsonlines`), '');
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang', 'v1\ten\nv2\ten\nv3\ten'],
    vn_titles: [
      'id\tlang\tofficial\ttitle\tlatin',
      'v1\ten\tt\tSTEINS;GATE\t\\N\nv2\ten\tt\tCLANNAD\t\\N\nv3\ten\tt\tFate/stay night\t\\N',
    ],
    entry_meta: ['id\trevision', 'v1\t1\nv2\t1\nv3\t1'],
    vn_staff: ['id\taid\trole', 'v1\t10\tscenario'],
    staff_alias: ['id\taid\tname', 's4\t10\tAuthored staff'],
    staff: ['id\tmain\tprod', 's4\t10\tp2'],
    releases: ['id\ttitle', 'r1\tAuthored release'],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete'],
    releases_producers: ['id\tpid\tdeveloper\tpublisher', 'r1\tp1\tt\tf'],
    producers: [
      'id\ttype\tname',
      'p1\tco\tAuthored producer\np2\tin\tIndividual producer\np9\tco\tUnselected producer',
    ],
    staff_extlinks: ['id\tlink', 's4\t1\ns4\t2'],
    producers_extlinks: ['id\tlink', 'p1\t1\np2\t7\np9\t5'],
    releases_extlinks: ['id\tlink', 'r1\t4'],
    vn_extlinks: ['id\tlink', ''],
    vn_relations: ['id\tvid\trelation', ''],
    vn_seiyuu: ['id\tcid\taid\tnote', ''],
    chars_vns: ['id\tvid\trole', ''],
    chars: ['id\tname', ''],
    vn_anime: ['id\taid', ''],
    releases_supersedes: ['id\trid', ''],
    releases_titles: ['id\ttitle', ''],
    anime: ['id\ttitle', ''],
    extlinks: [
      'id\tsite\tvalue',
      `1\twebsite\thttps://example.org/shared\n2\twebsite\t${staffSecond}\n4\twebsite\thttps://example.org/release\n5\twebsite\thttps://example.org/unselected\n6\twikidata\tQ1\n7\twebsite\thttps://example.org/individual`,
    ],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), body ? `${body}\n` : '');
  }
  return new CrossMediaDumpFiles(bangumi, directory);
}

test('production operator imports authored VNDB staff, producer and release websites through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-entity-websites-native-'));
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
    const path = join(directory, 'importer.sqlite');
    const firstPlan = await planCrossMediaSeed(await authoredDump(directory));
    expect(firstPlan.entities.vndb.some((row) => row.key === 'p9')).toBe(false);
    const first = await seedCrossMedia(firstPlan, path, runtime.importTransport, {
      origin: 'https://kernel.import.test',
    });
    const subject = (externalId: string) => {
      const reading = first.readings.find((entry) => entry.source === 'vndb' && entry.externalId === externalId);
      const id = (reading?.subject as { subject?: { id?: string } } | undefined)?.subject?.id;
      if (!id) throw new Error(`Authored source record ${externalId} was not bound`);
      return id;
    };
    const staffId = subject('s4');
    const producerId = subject('p1');
    const individualProducerId = subject('p2');
    const releaseId = subject('r1');
    expect(first.readings.some((entry) => entry.externalId === 'p9')).toBe(false);
    async function adoptUrl(subjectId: string, url: string) {
      const query = new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' });
      const page = await editor.http(`/v1/subjects/${subjectId}/candidates?${query}`);
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.statement.value.content === url);
      expect(candidate).toBeDefined();
      expect(
        candidate!.statement.references
          ?.flatMap((reference) => reference.parts)
          .some(
            (part) => part.property.id === 'schema:url' && String(part.value.content).startsWith('https://vndb.org/'),
          ),
      ).toBe(true);
      expect(
        (
          await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate!.id}:accept`, {
            context: globalContext,
            expected_head: candidate!.head,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${subjectId}:adopt`, {
            context: globalContext,
            property: 'schema:url',
            mode: 'replace',
            expected_head: listing.adoption?.head ?? null,
            selection: [{ candidate: candidate!.id, rank: candidate!.statement.rank ?? 'normal' }],
          })
        ).status,
      ).toBe(200);
    }
    await adoptUrl(staffId, 'https://example.org/shared');
    await adoptUrl(producerId, 'https://example.org/shared');
    await adoptUrl(individualProducerId, 'https://example.org/individual');
    await adoptUrl(releaseId, 'https://example.org/release');
    const staffPage = await editor.http(
      `/v1/subjects/${staffId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    expect(
      (staffPage.body as { candidates: Candidate[] }).candidates.map((item) => item.statement.value.content).sort(),
    ).toEqual(['https://example.org/shared', 'https://example.org/staff'].sort());
    async function current(subjectId: string) {
      const response = await runtime.request(
        `/v1/subjects/${subjectId}?${new URLSearchParams({ context: globalContext })}`,
      );
      expect(response.status).toBe(200);
      const view = (await response.json()) as {
        subject: {
          type: string;
          statements: Record<
            string,
            {
              value: { content: unknown };
              references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
            }[]
          >;
        };
      };
      return view.subject;
    }
    const staffView = await current(staffId);
    expect(staffView.type).toBe('schema:Person');
    expect(staffView.statements['schema:url']?.map((item) => item.value.content)).toEqual([
      'https://example.org/shared',
    ]);
    expect(
      staffView.statements['schema:url']?.[0]?.references
        ?.flatMap((reference) => reference.parts)
        .some((part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/s4'),
    ).toBe(true);
    expect((await current(producerId)).type).toBe('schema:Organization');
    expect((await current(producerId)).statements['schema:url']?.map((item) => item.value.content)).toEqual([
      'https://example.org/shared',
    ]);
    const individualProducerView = await current(individualProducerId);
    expect(individualProducerView.type).toBe('schema:Person');
    expect(individualProducerView.statements['schema:url']?.map((item) => item.value.content)).toEqual([
      'https://example.org/individual',
    ]);
    expect(
      individualProducerView.statements['schema:url']?.[0]?.references
        ?.flatMap((reference) => reference.parts)
        .some((part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/p2'),
    ).toBe(true);
    expect((await current(releaseId)).type).toBe('wd:Q20631656');
    expect((await current(releaseId)).statements['schema:url']?.map((item) => item.value.content)).toEqual([
      'https://example.org/release',
    ]);
    const again = await seedCrossMedia(firstPlan, path, runtime.importTransport, {
      origin: 'https://kernel.import.test',
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const changedPlan = await planCrossMediaSeed(await authoredDump(directory, 'https://example.org/staff-changed'));
    const changed = await seedCrossMedia(changedPlan, path, runtime.importTransport, {
      origin: 'https://kernel.import.test',
    });
    expect(changed.runs.vndb?.counts.unchanged).toBeGreaterThanOrEqual(0);
    const changedPage = await editor.http(
      `/v1/subjects/${staffId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    expect(
      (changedPage.body as { candidates: Candidate[] }).candidates.some(
        (item) => item.statement.value.content === 'https://example.org/staff-changed',
      ),
    ).toBe(true);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: 'vndb_cross_media',
      externalId: 's4',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    const fencedPlan = await planCrossMediaSeed(await authoredDump(directory, 'https://example.org/staff-fenced'));
    await seedCrossMedia(fencedPlan, path, runtime.importTransport, { origin: 'https://kernel.import.test' });
    const fencedPage = await editor.http(
      `/v1/subjects/${staffId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    expect(
      (fencedPage.body as { candidates: Candidate[] }).candidates.some(
        (item) => item.statement.value.content === 'https://example.org/staff-fenced',
      ),
    ).toBe(false);
    expect((await current(staffId)).statements['schema:url']?.map((item) => item.value.content)).toEqual([
      'https://example.org/shared',
    ]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
