import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision } from '../../../../packages/conversion/src/cross-media-entities.ts';
import { planCrossMediaSeed, seedCrossMedia, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

function tables(
  aliases: Record<string, unknown>[] = [
    { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
    { id: 's4', aid: '20', name: 'Later Alias', latin: null },
  ],
  extra: Record<string, Record<string, unknown>[]> = {},
) {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/vn': [
      { id: 'v1', olang: 'ja', alias: null },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '1', lastmod: '2026-10-25 00:00:00+00' },
    ],
    'vndb/vn_staff': [{ id: 'v1', aid: '20', role: 'scenario', note: 'Writer Alias' }],
    'vndb/staff_alias': aliases,
    'vndb/staff': [{ id: 's4', gender: null, lang: 'ja', main: '10', description: '', prod: null }],
    ...extra,
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  source?: { converter_revision?: string; external_id?: string };
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
  };
};

test('production operator imports VNDB staff preferred and additional source names through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-staff-names-native-'));
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
    async function acceptAdoptNames(subjectId: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const sourced = listing.candidates.filter((item) => item.source && item.retracted == null);
      for (const candidate of sourced) {
        const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
          context: globalContext,
          expected_head: candidate.head,
        });
        expect(accepted.status).toBe(200);
      }
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context: globalContext,
        property: 'schema:name',
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: sourced.map((candidate) => ({
          candidate: candidate.id,
          rank: candidate.statement.rank ?? 'normal',
        })),
      });
      expect(adopted.status).toBe(200);
    }
    const path = join(directory, 'state.sqlite');
    const extras = { providers: ['vndb'] as const, mediaDeadlineMs: 0, entitiesFirst: true };
    const first = await seedCrossMedia(
      await planCrossMediaSeed(tables()),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const subjectId = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const staff = first.readings.find((row) => row.externalId === 's4');
    const work = first.readings.find((row) => row.externalId === 'v1');
    expect(staff && work).toBeTruthy();
    const staffId = subjectId(staff!);
    const workId = subjectId(work!);
    expect(staffId && workId && staffId !== workId).toBeTruthy();
    await acceptAdoptNames(staffId!);
    const authorPage = await editor.http(
      `/v1/subjects/${workId}/candidates?${new URLSearchParams({ property: 'schema:author', context: globalContext, limit: '100' })}`,
    );
    const author = (authorPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source);
    if (author) {
      const accepted = await editor.http(`/v1/subjects/${workId}/candidates/${author.id}:accept`, {
        context: globalContext,
        expected_head: author.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${workId}:adopt`, {
        context: globalContext,
        property: 'schema:author',
        mode: 'replace',
        expected_head: null,
        selection: [{ candidate: author.id, rank: author.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
    }
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          type: string;
          labels?: Record<string, string>;
          statements: Record<
            string,
            { value: { content: unknown }; qualifiers?: { property: { id: string }; value: { content: unknown } }[] }[]
          >;
        };
      };
    };
    const current = await read(staffId!);
    expect(current.subject.type).toBe('schema:Person');
    expect(current.subject.labels?.und).toBe('Preferred Alias');
    expect(current.subject.statements['schema:name']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'Preferred Alias' },
        { language: 'und', text: 'Later Alias' },
      ]),
    );
    expect(current.subject.statements['schema:name']).toHaveLength(2);
    const namePage = await editor.http(
      `/v1/subjects/${staffId}/candidates?${new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' })}`,
    );
    const named = (namePage.body as { candidates: Candidate[] }).candidates.filter((item) => item.source);
    expect(named.every((item) => item.source?.converter_revision === converter_revision)).toBe(true);
    expect(
      named.every((item) =>
        item.statement.references?.some((reference) =>
          reference.parts.some(
            (part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/s4',
          ),
        ),
      ),
    ).toBe(true);
    const shuffled = await seedCrossMedia(
      await planCrossMediaSeed(
        tables([
          { id: 's4', aid: '20', name: 'Later Alias', latin: null },
          { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
        ]),
      ),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    expect(subjectId(shuffled.readings.find((row) => row.externalId === 's4')!)).toBe(staffId);
    const reopen = await seedCrossMedia(
      await planCrossMediaSeed(tables()),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    expect(subjectId(reopen.readings.find((row) => row.externalId === 's4')!)).toBe(staffId);
    const outsider = await seedCrossMedia(
      await planCrossMediaSeed(
        tables(undefined, {
          'vndb/staff_alias': [
            { id: 's4', aid: '20', name: 'Later Alias', latin: null },
            { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
            { id: 's9', aid: '30', name: 'Preferred Alias', latin: null },
          ],
          'vndb/staff': [
            { id: 's4', gender: null, lang: 'ja', main: '10', description: '', prod: null },
            { id: 's9', gender: null, lang: 'ja', main: '30', description: '', prod: null },
          ],
        }),
      ),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    expect(outsider.readings.filter((row) => row.externalId.startsWith('s')).map((row) => row.externalId)).toEqual([
      's4',
    ]);
    await seedCrossMedia(
      await planCrossMediaSeed(
        tables([
          { id: 's4', aid: '20', name: 'Changed Alias', latin: null },
          { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
        ]),
      ),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    const changed = await editor.http(
      `/v1/subjects/${staffId}/candidates?${new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' })}`,
    );
    expect(
      (changed.body as { candidates: Candidate[] }).candidates.some(
        (item) =>
          item.source &&
          item.statement.value.content &&
          typeof item.statement.value.content === 'object' &&
          'text' in item.statement.value.content &&
          item.statement.value.content.text === 'Changed Alias',
      ),
    ).toBe(true);
    await seedCrossMedia(
      await planCrossMediaSeed(
        tables([
          { id: 's4', aid: '20', name: 'Later Alias', latin: null },
          { id: 's4', aid: '10', name: 'Renamed Preferred', latin: null },
        ]),
      ),
      path,
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    const renamed = await editor.http(
      `/v1/subjects/${staffId}/candidates?${new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' })}`,
    );
    expect(
      (renamed.body as { candidates: Candidate[] }).candidates.some(
        (item) =>
          item.source &&
          item.statement.value.content &&
          typeof item.statement.value.content === 'object' &&
          'text' in item.statement.value.content &&
          item.statement.value.content.text === 'Renamed Preferred',
      ),
    ).toBe(true);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 's4',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await seedCrossMedia(
      await planCrossMediaSeed(
        tables([
          { id: 's4', aid: '20', name: 'Fenced Alias', latin: null },
          { id: 's4', aid: '10', name: 'Preferred Alias', latin: null },
        ]),
      ),
      join(directory, 'fence.sqlite'),
      runtime.importTransport,
      { origin: 'https://kernel.import.test' },
      extras,
    );
    const fenced = await read(staffId!);
    expect(JSON.stringify(fenced.subject.statements['schema:name'] ?? [])).not.toContain('Fenced Alias');
    const disclosed = await editor.http(`/v1/subjects/${staffId}?context=${globalContext}`);
    expect(disclosed.status).toBe(200);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
