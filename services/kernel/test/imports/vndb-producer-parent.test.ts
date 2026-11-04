import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseDigest, type Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
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

async function authoredDump(directory: string, relations = 'p1\tp2\tpar\np1\tp3\tsub') {
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
    releases: ['id', 'r1'],
    releases_vn: ['id\tvid', 'r1\tv1'],
    releases_producers: ['id\tpid\tdeveloper\tpublisher', 'r1\tp1\tt\tf'],
    producers: [
      'id\ttype\tname',
      'p1\tco\tAuthored studio\np2\tco\tAuthored parent\np3\tng\tAuthored subsidiary\np4\tin\tAuthored person',
    ],
    producers_relations: ['id\tpid\trelation', relations],
  };
  for (const name of [
    'anime',
    'chars',
    'chars_vns',
    'extlinks',
    'releases_supersedes',
    'releases_titles',
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

function olderRelease(): Release {
  const release = structuredClone(bundledRelease) as Release;
  release.catalogue = { ...release.catalogue, version: '1.0.1-history-control' };
  delete release.properties['wdt:P749'];
  const definition = release.types['schema:Organization'];
  if (definition) definition.properties = definition.properties.filter((id) => id !== 'wdt:P749');
  return release;
}

type Candidate = {
  id: string;
  head: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred' };
  source?: unknown;
};

test('operator imports authored VNDB parent and subsidiary rows through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-producer-parent-native-'));
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
      actions: [
        'context:accept',
        'context:adopt',
        'definitions:publish',
        'definitions:activate',
        'gate:definition_publication',
      ],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const tables = await authoredDump(
      directory,
      'p1\tp2\tpar\np1\tp3\tsub\np1\tp4\tpar\np1\tp9\tpar\np1\tp2\told\np2\tp1\tpar',
    );
    const path = join(directory, 'state.sqlite');
    const first = await seedCrossMedia(await planCrossMediaSeed(tables), path, runtime.importTransport, {
      origin: 'https://kernel.import.test',
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.gaps.some((gap) => gap.record.pid === 'p4' && gap.requiredProfile === 'schema:Person')).toBe(true);
    expect(first.gaps.some((gap) => gap.record.pid === 'p9')).toBe(true);
    expect(first.gaps.some((gap) => gap.record.relation === 'old')).toBe(true);
    expect(first.gaps.some((gap) => gap.reason.includes('cyclic'))).toBe(true);
    const subjectId = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const child = first.readings.find((row) => row.externalId === 'p1');
    const parent = first.readings.find((row) => row.externalId === 'p2');
    const subsidiary = first.readings.find((row) => row.externalId === 'p3');
    const person = first.readings.find((row) => row.externalId === 'p4');
    expect(child && parent && subsidiary && person).toBeTruthy();
    const childId = subjectId(child!);
    const parentId = subjectId(parent!);
    const subsidiaryId = subjectId(subsidiary!);
    expect(childId && parentId && subsidiaryId).toBeTruthy();
    async function acceptAdopt(subject: string, property: string, target: string) {
      const page = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.statement.value.content === target && item.source)!;
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
    await acceptAdopt(childId!, 'wdt:P749', parentId!);
    await acceptAdopt(subsidiaryId!, 'wdt:P749', childId!);
    const current = await editor.http(`/v1/subjects/${childId}?context=${globalContext}`);
    expect(current.status).toBe(200);
    expect(
      (
        current.body as { subject: { type: string; statements: Record<string, { value: { content: unknown } }[]> } }
      ).subject.statements['wdt:P749']?.map((item) => item.value.content),
    ).toEqual([parentId]);
    const inverse = await editor.http(
      `/v1/subjects/${parentId}/links?${new URLSearchParams({ property: 'wdt:P749', limit: '20' })}`,
    );
    expect(inverse.status).toBe(200);
    expect((inverse.body as { links: { subject: string }[] }).links.some((row) => row.subject === childId)).toBe(true);
    const personRead = await editor.http(`/v1/subjects/${subjectId(person!)}?context=${globalContext}`);
    expect((personRead.body as { subject: { type: string } }).subject.type).toBe('schema:Person');
    const again = await seedCrossMedia(await planCrossMediaSeed(tables), path, runtime.importTransport, {
      origin: 'https://kernel.import.test',
    });
    expect(again.readings.map((row) => row.externalId).sort()).toEqual(
      first.readings.map((row) => row.externalId).sort(),
    );
    const changed = await authoredDump(join(directory, 'changed'), 'p1\tp3\tpar');
    await seedCrossMedia(await planCrossMediaSeed(changed), path, runtime.importTransport, {
      origin: 'https://kernel.import.test',
    });
    const later = await editor.http(
      `/v1/subjects/${childId}/candidates?${new URLSearchParams({ property: 'wdt:P749', context: globalContext, limit: '100' })}`,
    );
    expect(
      (later.body as { candidates: Candidate[] }).candidates.some(
        (item) => item.statement.value.content === subsidiaryId && item.source,
      ),
    ).toBe(true);
    const old = olderRelease();
    const digest = releaseDigest(old);
    const published = await editor.http('/v1/definitions/releases', { release: old });
    expect([200, 201]).toContain(published.status);
    const activated = await editor.http(`/v1/definitions/releases/${digest}:activate`, { expected_head: 1 });
    expect([200, 201]).toContain(activated.status);
    const refused = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: 'historical-p749',
          source: {
            source: crossMediaAliases.vndb,
            external_id: 'p1',
            record_revision: 'unversioned',
            converter_revision: 'authored@1',
            digest: 'e'.repeat(64),
            field_group: 'facts',
          },
          subject: childId!,
          statement: {
            property: { id: 'wdt:P749' },
            value: { type: 'value', content: parentId! },
            references: [
              { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://vndb.org/p1' } }] },
            ],
          },
        },
      ],
    });
    expect(refused.results[0]?.status).not.toBe(201);
    await editor.http(`/v1/definitions/releases/${bundledDigest}:activate`, {
      expected_head: (activated.body as { head?: number }).head ?? 2,
    });
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'p1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    const fenced = await seedCrossMedia(
      await planCrossMediaSeed(await authoredDump(join(directory, 'fenced'), 'p1\tp2\tpar')),
      join(directory, 'fence.sqlite'),
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
    );
    expect(
      fenced.unresolved.some((row) => row.reason === 'fenced_relation_holder') ||
        fenced.status === 'imported-with-gaps',
    ).toBe(true);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
