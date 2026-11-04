import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  appearanceRoleConceptUri,
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
  importVndbCharacterTraits,
  readVndbCharacterVocabularyBindings,
} from '../../../importer/src/vndb-character-traits.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const authored = {
  source: 'authored-vndb-character-vocabulary',
  converter_revision: 'authored@1',
  field_group: 'facts' as const,
};

function tables(overrides: { traits?: Record<string, unknown>[]; appearances?: Record<string, unknown>[] } = {}) {
  const traits = overrides.traits ?? [
    { id: 'c1', tid: 'i73', spoil: '1', lie: 'f' },
    { id: 'c2', tid: 'i80', spoil: '0', lie: 't' },
  ];
  const appearances = overrides.appearances ?? [
    { id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' },
    { id: 'c2', vid: 'v1', rid: 'r9', role: 'side', spoil: '1' },
  ];
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider !== 'vndb') return;
      if (table === 'vn') yield { id: 'v1', olang: 'ja', alias: null };
      if (table === 'vn_titles')
        yield { id: 'v1', lang: 'ja', official: 't', title: 'Authored visual novel', latin: null };
      if (table === 'entry_meta') yield { id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' };
      if (table === 'chars') {
        yield { id: 'c1', name: 'Authored heroine', main: 'c3', main_spoil: '1' };
        yield { id: 'c2', name: 'Authored side character', main: null };
        yield { id: 'c3', name: 'Authored main version', main: null };
      }
      if (table === 'chars_traits') yield* traits;
      if (table === 'chars_vns') yield* appearances;
    },
  };
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  source?: unknown;
  statement: {
    value: { type?: string; content: unknown };
    rank?: 'normal' | 'preferred';
    qualifiers?: { property: { id: string }; value: { type?: string; content: unknown } }[];
  };
};

test('production operator imports authored VNDB character traits and appearances through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-traits-native-'));
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
    const digest = (label: string) => Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
    async function createSubject(externalId: string, type: string, label: string) {
      const created = await runtime.importTransport.batch({
        commands: [
          {
            op: 'create',
            key: `authored-${externalId}`,
            source: {
              ...authored,
              external_id: externalId,
              record_revision: 'unversioned',
              digest: digest(externalId),
            },
            subject: { type, labels: { en: label } },
          },
        ],
      });
      expect(created.results[0]?.status).toBe(201);
      return (created.results[0] as { value: { id: string } }).value.id;
    }
    async function propose(externalId: string, subject: string, property: string, content: unknown, url: string) {
      const result = await runtime.importTransport.batch({
        commands: [
          {
            op: 'propose',
            key: `authored-${externalId}-${property}`,
            source: {
              ...authored,
              external_id: externalId,
              record_revision: 'unversioned',
              digest: digest(externalId),
            },
            subject,
            statement: {
              property: { id: property },
              value: { type: 'value', content },
              references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }] }],
            },
          },
        ],
      });
      expect(result.results[0]?.status).toBe(201);
    }
    async function acceptAdopt(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.source) ?? listing.candidates[0]!;
      const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
        context: globalContext,
        expected_head: candidate.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
    }
    const traitSchemeId = await createSubject('trait-scheme', 'skos:ConceptScheme', 'Authored VNDB character traits');
    const hairId = await createSubject('trait-i73', 'skos:Concept', 'Authored hair trait');
    const roleSchemeId = await createSubject('role-scheme', 'skos:ConceptScheme', 'Authored VNDB appearance roles');
    const mainRoleId = await createSubject('role-main', 'skos:Concept', 'Main');
    await propose('trait-scheme', traitSchemeId, 'schema:url', characterTraitSchemeUri, characterTraitSchemeUri);
    await propose('trait-i73', hairId, 'schema:url', characterTraitConceptUri('i73'), characterTraitConceptUri('i73'));
    await propose('trait-i73', hairId, 'skos:inScheme', traitSchemeId, characterTraitConceptUri('i73'));
    await propose('role-scheme', roleSchemeId, 'schema:url', appearanceRoleSchemeUri, appearanceRoleSchemeUri);
    await propose(
      'role-main',
      mainRoleId,
      'schema:url',
      appearanceRoleConceptUri('main'),
      appearanceRoleConceptUri('main'),
    );
    await propose('role-main', mainRoleId, 'skos:inScheme', roleSchemeId, appearanceRoleConceptUri('main'));
    for (const [subjectId, property] of [
      [traitSchemeId, 'schema:url'],
      [hairId, 'schema:url'],
      [hairId, 'skos:inScheme'],
      [roleSchemeId, 'schema:url'],
      [mainRoleId, 'schema:url'],
      [mainRoleId, 'skos:inScheme'],
    ] as const)
      await acceptAdopt(subjectId, property);
    const bindings = await readVndbCharacterVocabularyBindings(runtime.importTransport, {
      traits: { schemeId: traitSchemeId, concepts: [{ code: 'i73', id: hairId }] },
      roles: { schemeId: roleSchemeId, concepts: [{ code: 'main', id: mainRoleId }] },
    });
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((item) => item.id).sort()).toEqual([hairId, mainRoleId].sort());
    const path = join(directory, 'state.sqlite');
    const first = await importVndbCharacterTraits({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status).toBe('imported-with-gaps');
    expect(first.gaps.some((gap) => gap.reason.includes('chars_traits.lie'))).toBe(true);
    expect(first.gaps.some((gap) => gap.reason.includes('chars_vns.rid'))).toBe(true);
    expect(first.gaps.some((gap) => gap.reason.includes('chars.main'))).toBe(true);
    const subjectId = (reading: (typeof first.readings)[number] | undefined) =>
      (reading?.subject as { subject?: { id: string } }).subject?.id ?? (reading?.subject as { id?: string }).id;
    const heroineId = subjectId(first.readings.find((row) => row.externalId === 'c1'));
    const sideId = subjectId(first.readings.find((row) => row.externalId === 'c2'));
    const versionId = subjectId(first.readings.find((row) => row.externalId === 'c3'));
    const workId = subjectId(first.readings.find((row) => row.externalId === 'v1'));
    expect(heroineId && sideId && versionId && workId).toBeTruthy();
    expect(new Set([heroineId, sideId, versionId, workId]).size).toBe(4);
    await acceptAdopt(heroineId!, 'schema:keywords');
    await acceptAdopt(workId!, 'schema:character');
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          type: string;
          statements: Record<
            string,
            {
              value: { type?: string; content: unknown };
              qualifiers?: { property: { id: string }; value: { type?: string; content: unknown } }[];
            }[]
          >;
        };
      };
    };
    const heroine = await read(heroineId!);
    expect(heroine.subject.type).toBe('wd:Q95074');
    expect(heroine.subject.statements['schema:keywords']?.map((item) => item.value.content)).toEqual([hairId]);
    expect(heroine.subject.statements['schema:keywords']?.[0]?.qualifiers).toContainEqual({
      property: { id: 'rezics:spoilerLevel' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    });
    const side = await read(sideId!);
    expect(side.subject.statements['schema:keywords'] ?? []).toEqual([]);
    const work = await read(workId!);
    expect(work.subject.type).toBe('wd:Q689445');
    expect(work.subject.statements['schema:character']?.map((item) => item.value.content)).toEqual([heroineId]);
    expect(work.subject.statements['schema:character']?.[0]?.qualifiers).toEqual(
      expect.arrayContaining([
        { property: { id: 'wdt:P3831' }, value: { type: 'value', content: mainRoleId } },
        { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+0', unit: '1' } } },
      ]),
    );
    expect(work.subject.statements['schema:character']?.some((item) => item.value.content === sideId)).toBe(false);
    expect(JSON.stringify(heroine.subject.statements)).not.toContain(versionId);
    expect(JSON.stringify([heroine.subject.statements, work.subject.statements, first.gaps])).not.toMatch(
      /ballot|voter|sameCharacters/,
    );
    const again = await importVndbCharacterTraits({
      tables: tables(),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    await importVndbCharacterTraits({
      tables: tables({ traits: [{ id: 'c1', tid: 'i73', spoil: '2', lie: 'f' }] }),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const keywords = await editor.http(
      `/v1/subjects/${heroineId}/candidates?${new URLSearchParams({ property: 'schema:keywords', context: globalContext, limit: '100' })}`,
    );
    const spoilerAmounts = (keywords.body as { candidates: Candidate[] }).candidates.flatMap((item) =>
      (item.statement.qualifiers ?? [])
        .filter((qualifier) => qualifier.property.id === 'rezics:spoilerLevel')
        .map((qualifier) => qualifier.value.content),
    );
    expect(spoilerAmounts).toEqual(
      expect.arrayContaining([
        { amount: '+1', unit: '1' },
        { amount: '+2', unit: '1' },
      ]),
    );
    const hairUrlPage = await editor.http(
      `/v1/subjects/${hairId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    const hairUrl = (hairUrlPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    expect((await editor.http(`/v1/statements/${hairUrl.id}/retract`, {})).status).toBe(200);
    const withheld = await readVndbCharacterVocabularyBindings(runtime.importTransport, {
      traits: { schemeId: traitSchemeId, concepts: [{ code: 'i73', id: hairId }] },
      roles: { schemeId: roleSchemeId, concepts: [{ code: 'main', id: mainRoleId }] },
    });
    expect(withheld.concepts.some((item) => item.id === hairId)).toBe(false);
    const beforeFence = (keywords.body as { candidates: Candidate[] }).candidates.length;
    await importVndbCharacterTraits({
      tables: tables({ traits: [{ id: 'c1', tid: 'i73', spoil: '2', lie: 'f' }] }),
      path,
      port: runtime.importTransport,
      bindings: withheld,
      destination: { origin: 'https://kernel.import.test' },
    });
    const afterRetract = await editor.http(
      `/v1/subjects/${heroineId}/candidates?${new URLSearchParams({ property: 'schema:keywords', context: globalContext, limit: '100' })}`,
    );
    const live = (afterRetract.body as { candidates: Candidate[] }).candidates.filter((item) => !item.retracted);
    expect(live.filter((item) => item.statement.value.content === hairId).length).toBeLessThanOrEqual(beforeFence);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'c1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbCharacterTraits({
      tables: tables({ traits: [{ id: 'c1', tid: 'i73', spoil: '0', lie: 'f' }] }),
      path,
      port: runtime.importTransport,
      bindings: withheld,
      destination: { origin: 'https://kernel.import.test' },
    });
    const fenced = await editor.http(
      `/v1/subjects/${heroineId}/candidates?${new URLSearchParams({ property: 'schema:keywords', context: globalContext, limit: '100' })}`,
    );
    const amounts = (fenced.body as { candidates: Candidate[] }).candidates.flatMap((item) =>
      (item.statement.qualifiers ?? [])
        .filter((qualifier) => qualifier.property.id === 'rezics:spoilerLevel')
        .map((qualifier) => (qualifier.value.content as { amount?: string }).amount),
    );
    expect(amounts).not.toContain('+0');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
