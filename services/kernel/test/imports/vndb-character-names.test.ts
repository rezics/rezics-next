import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

function authoredTables(primaryName = '桜', spoiler = '2'): CrossMediaTables {
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
    'vndb/vn_anime': [{ id: 'v1', aid: '123' }],
    'vndb/chars_vns': [
      { id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' },
      { id: 'c2', vid: 'v2', rid: null, role: 'side', spoil: '0' },
    ],
    'vndb/chars': [{ id: 'c1', main: null }, { id: 'c2', main: null }],
    'vndb/chars_names': [
      { id: 'c1', lang: 'ja', name: primaryName, latin: 'Sakura' },
      { id: 'c1', lang: 'zh-Hant', name: '櫻', latin: null },
      { id: 'c2', lang: 'ja', name: '桜', latin: null },
      { id: 'c99', lang: 'ja', name: '桜', latin: null },
    ],
    'vndb/chars_alias': [
      { id: 'c1', spoil: spoiler, name: 'Shared alias', latin: 'Shared romanization' },
      { id: 'c2', spoil: '1', name: 'Shared alias', latin: null },
      { id: 'c99', spoil: '2', name: 'Shared alias', latin: null },
    ],
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  source?: unknown;
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    qualifiers?: { property: { id: string }; value: { type?: string; content: unknown } }[];
  };
};

test('selected VNDB character names and qualified aliases reach one acknowledged Character', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-names-native-'));
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
    const importPlan = async (name = '桜', spoiler = '2') =>
      planCrossMediaSeed(authoredTables(name, spoiler));
    const state = join(directory, 'state.sqlite');
    const run = async (name = '桜', spoiler = '2') =>
      seedCrossMedia(await importPlan(name, spoiler), state, runtime.importTransport, {
        origin: 'https://kernel.import.test',
      });
    const bootstrap = await run();
    expect(bootstrap.status === 'imported' || bootstrap.status === 'imported-with-gaps').toBe(true);
    const first = await run();
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const character1 = first.readings.find((row) => row.externalId === 'c1');
    const character2 = first.readings.find((row) => row.externalId === 'c2');
    expect(character1 && character2).toBeTruthy();
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string }; id?: string }).subject?.id ??
      (row.subject as { id?: string }).id;
    const character1Id = idOf(character1!);
    const character2Id = idOf(character2!);
    expect(character1Id && character2Id).toBeTruthy();
    expect(character1Id).not.toBe(character2Id);

    async function listing(subject: string, property: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      return response.body as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function acceptAdopt(subject: string, property: string) {
      const initial = await listing(subject, property);
      const sourced = initial.candidates.filter((candidate) => candidate.source && !candidate.retracted);
      expect(sourced.length).toBeGreaterThan(0);
      for (const candidate of sourced) {
        const latest = await listing(subject, property);
        const current = latest.candidates.find((item) => item.id === candidate.id)!;
        const accepted = await editor.http(`/v1/subjects/${subject}/candidates/${candidate.id}:accept`, {
          context: globalContext,
          expected_head: current.head,
        });
        expect(accepted.status).toBe(200);
      }
      const latest = await listing(subject, property);
      const active = latest.candidates.filter((candidate) => candidate.source && !candidate.retracted);
      const adopted = await editor.http(`/v1/subjects/${subject}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: latest.adoption?.head ?? null,
        selection: active.map((candidate) => ({
          candidate: candidate.id,
          rank: candidate.statement.rank ?? 'normal',
        })),
      });
      expect(adopted.status).toBe(200);
    }
    for (const subject of [character1Id!, character2Id!]) {
      await acceptAdopt(subject, 'schema:name');
      await acceptAdopt(subject, 'schema:alternateName');
    }
    const read = async (subject: string) => {
      const response = await editor.http(`/v1/subjects/${subject}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          id: string;
          type: string;
          statements: Record<
            string,
            {
              value: { content: unknown };
              qualifiers?: { property: { id: string }; value: { content: unknown } }[];
              references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
            }[]
          >;
        };
      };
    };
    const current1 = await read(character1Id!);
    const current2 = await read(character2Id!);
    expect(current1.subject.type).toBe('wd:Q95074');
    expect(current1.subject.statements['schema:name']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'ja', text: '桜' },
        { language: 'zh-Hant', text: '櫻' },
      ]),
    );
    expect(current1.subject.statements['schema:alternateName']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'ja-Latn', text: 'Sakura' },
        { language: 'und', text: 'Shared alias' },
        { language: 'und-Latn', text: 'Shared romanization' },
      ]),
    );
    const disclosed = current1.subject.statements['schema:alternateName']?.find(
      (item) => JSON.stringify(item.value.content) === JSON.stringify({ language: 'und', text: 'Shared alias' }),
    );
    expect(
      disclosed?.qualifiers?.map((qualifier) => ({
        property: qualifier.property.id,
        content: qualifier.value.content,
      })),
    ).toEqual([{ property: 'rezics:spoilerLevel', content: 2 }]);
    expect(
      current1.subject.statements['schema:name']?.[0]?.references?.[0]?.parts,
    ).toContainEqual({ property: { id: 'schema:url' }, value: { content: 'https://vndb.org/c1' } });
    expect(current2.subject.statements['schema:name']?.map((item) => item.value.content)).toContainEqual({
      language: 'ja',
      text: '桜',
    });
    const otherAlias = current2.subject.statements['schema:alternateName']?.find(
      (item) => JSON.stringify(item.value.content) === JSON.stringify({ language: 'und', text: 'Shared alias' }),
    );
    expect(
      otherAlias?.qualifiers?.map((qualifier) => ({
        property: qualifier.property.id,
        content: qualifier.value.content,
      })),
    ).toEqual([{ property: 'rezics:spoilerLevel', content: 1 }]);

    const repeated = await run();
    expect(repeated.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(idOf(repeated.readings.find((row) => row.externalId === 'c1')!)).toBe(character1Id);
    const changed = await run('桜・改', '1');
    expect(changed.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const changedNames = await listing(character1Id!, 'schema:name');
    expect(
      changedNames.candidates.some(
        (item) => JSON.stringify(item.statement.value.content) === JSON.stringify({ language: 'ja', text: '桜・改' }),
      ),
    ).toBe(true);
    const changedAliases = await listing(character1Id!, 'schema:alternateName');
    expect(
      changedAliases.candidates.some(
        (item) =>
          JSON.stringify(item.statement.value.content) === JSON.stringify({ language: 'und', text: 'Shared alias' }) &&
          item.statement.qualifiers?.some(
            (qualifier) => qualifier.property.id === 'rezics:spoilerLevel' && qualifier.value.content === 1,
          ),
      ),
    ).toBe(true);

    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'c1',
      fieldGroup: 'facts',
      reason: 'Authored source fence',
    });
    expect(fence.status).toBe(200);
    await run('Fenced name', '2');
    const fencedNames = await listing(character1Id!, 'schema:name');
    expect(
      fencedNames.candidates.some(
        (item) => JSON.stringify(item.statement.value.content) === JSON.stringify({ language: 'ja', text: 'Fenced name' }),
      ),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
