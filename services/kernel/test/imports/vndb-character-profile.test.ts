import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCrossMediaSeed,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import {
  parseVndbCharacterProfileReferences,
  readVndbCharacterProfileBindings,
} from '../../../importer/src/vndb-character-profile.ts';
import { seedShowcaseVndbReleases } from '../../../importer/src/showcase-vndb-releases.ts';
import {
  vndbCharacterBloodTypeConceptUri,
  vndbCharacterBloodTypeSchemeUri,
} from '@rezics/conversion/vndb-vocabulary';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const authored = { source: 'authored-vndb-character-profile', converter_revision: 'authored@1', field_group: 'facts' as const };
const centimetre = 'http://www.wikidata.org/entity/Q174728';

function tables(): CrossMediaTables {
  const vndb: Record<string, Record<string, unknown>[]> = {
    vn: ['v1', 'v2', 'v3'].map((id) => ({ id, olang: 'ja', alias: null })),
    vn_titles: [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    entry_meta: ['v1', 'v2', 'v3'].map((id) => ({ id, revision: '1', lastmod: '2026-11-04 00:00:00+00' })),
    chars_vns: ['c1', 'c2', 'c3'].map((id, index) => ({ id, vid: 'v1', rid: null, role: index ? 'side' : 'main', spoil: '0' })),
    chars: [
      { id: 'c1', bloodt: 'a', gender: 'm', spoil_gender: 'f', height: '157', weight: '48' },
      { id: 'c2', bloodt: 'unknown', gender: 'o', spoil_gender: 'a', height: '0', weight: null },
      { id: 'c3', bloodt: 'b', gender: 'a', spoil_gender: 'o', height: '0', weight: null },
    ],
    chars_names: [{ id: 'c1', lang: 'ja', name: 'Authored heroine', latin: 'Heroine' }],
  };
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi') {
        if (table === 'subject')
          yield* [
            { id: 1, type: 2, name: 'STEINS;GATE' },
            { id: 2, type: 2, name: 'CLANNAD' },
            { id: 3, type: 2, name: 'Fate/stay night' },
          ];
        return;
      }
      yield* (vndb[table] ?? []);
    },
  };
}

type Candidate = {
  id: string;
  head: number | null;
  source?: unknown;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred' };
};

test('selected VNDB Character keeps verified blood type through independent review, refresh and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-profile-native-'));
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
    const digest = (value: string) => Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
    async function create(externalId: string, type: string, label: string) {
      const result = await runtime.importTransport.batch({
        commands: [{
          op: 'create',
          key: `profile-${externalId}`,
          source: { ...authored, external_id: externalId, record_revision: 'unversioned', digest: digest(externalId) },
          subject: { type, labels: { en: label } },
        }],
      });
      expect(result.results[0]?.status).toBe(201);
      return (result.results[0] as { value: { id: string } }).value.id;
    }
    async function propose(externalId: string, subject: string, property: string, content: string) {
      const result = await runtime.importTransport.batch({
        commands: [{
          op: 'propose',
          key: `profile-${externalId}-${property}`,
          source: { ...authored, external_id: externalId, record_revision: 'unversioned', digest: digest(externalId) },
          subject,
          statement: {
            property: { id: property },
            value: { type: 'value', content },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content } }] }],
          },
        }],
      });
      expect(result.results[0]?.status).toBe(201);
    }
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
      return candidate;
    }
    const schemeId = await create('blood-scheme', 'skos:ConceptScheme', 'VNDB character blood types');
    const otherSchemeId = await create('other-scheme', 'skos:ConceptScheme', 'Other source scheme');
    const typeAId = await create('blood-a', 'skos:Concept', 'Source blood type A');
    const typeBId = await create('blood-b', 'skos:Concept', 'Source blood type B');
    await propose('blood-scheme', schemeId, 'schema:url', vndbCharacterBloodTypeSchemeUri);
    await propose('other-scheme', otherSchemeId, 'schema:url', 'https://example.org/schemes/other');
    await propose('blood-a', typeAId, 'schema:url', vndbCharacterBloodTypeConceptUri('a'));
    await propose('blood-a', typeAId, 'skos:inScheme', schemeId);
    await propose('blood-b', typeBId, 'schema:url', vndbCharacterBloodTypeConceptUri('b'));
    await propose('blood-b', typeBId, 'skos:inScheme', otherSchemeId);
    for (const [subject, property] of [
      [schemeId, 'schema:url'],
      [otherSchemeId, 'schema:url'],
      [typeAId, 'schema:url'],
      [typeAId, 'skos:inScheme'],
      [typeBId, 'schema:url'],
      [typeBId, 'skos:inScheme'],
    ] as const)
      await acceptAdopt(subject, property);
    const references = parseVndbCharacterProfileReferences({
      schemeId,
      concepts: [{ code: 'a', id: typeAId }, { code: 'b', id: typeBId }],
    });
    const currentBindings = () => readVndbCharacterProfileBindings(runtime.importTransport, references);
    const bindingSet = await currentBindings();
    expect(bindingSet.concepts.map((item) => item.id)).toEqual([typeAId]);
    const path = join(directory, 'state.sqlite');
    const sourceTables = tables();
    const plan = await planCrossMediaSeed(sourceTables);
    const seed = (vndbCharacterProfileBindings: Awaited<ReturnType<typeof currentBindings>>) =>
      seedShowcaseVndbReleases({
        tables: sourceTables,
        plan,
        path,
        port: runtime.importTransport,
        destination: { origin: 'https://kernel.import.test' },
        extras: { providers: ['vndb'], vndbCharacterProfileBindings, mediaDeadlineMs: 0 },
      });
    const first = await seed(bindingSet);
    expect(first.vndbCharacterProfileRequirements.map((item) => item.code)).toEqual(['a', 'b']);
    const subjectId = (result: typeof first, key: string) => {
      const reading = result.readings.find((row) => row.externalId === key);
      return (reading?.subject as { subject?: { id: string } }).subject?.id ?? (reading?.subject as { id?: string }).id;
    };
    const heroineId = subjectId(first, 'c1');
    const unknownId = subjectId(first, 'c2');
    const wrongSchemeId = subjectId(first, 'c3');
    expect(heroineId && unknownId && wrongSchemeId).toBeTruthy();
    expect(new Set([heroineId, unknownId, wrongSchemeId]).size).toBe(3);
    const candidatePage = async (id: string, property: string) => {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      return response.body as { candidates: Candidate[]; adoption: { head: number } | null };
    };
    const bloodCandidates = await candidatePage(heroineId!, 'wdt:P1853');
    expect(bloodCandidates.candidates).toHaveLength(1);
    expect(bloodCandidates.candidates[0]?.statement.value.content).toBe(typeAId);
    expect((await candidatePage(unknownId!, 'wdt:P1853')).candidates).toEqual([]);
    expect((await candidatePage(wrongSchemeId!, 'wdt:P1853')).candidates).toEqual([]);
    expect((await candidatePage(heroineId!, 'schema:gender')).candidates).toEqual([]);
    await acceptAdopt(heroineId!, 'wdt:P1853');
    await acceptAdopt(heroineId!, 'schema:name');
    await acceptAdopt(heroineId!, 'schema:height');
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
    expect(heroine.subject.statements['wdt:P1853']?.[0]?.value.content).toBe(typeAId);
    expect(JSON.stringify(heroine.subject.statements['wdt:P1853']?.[0]?.references)).toContain('https://vndb.org/c1');
    expect(JSON.stringify(heroine.subject.statements['wdt:P1853']?.[0]?.references)).toContain('/chars/bloodt');
    expect(heroine.subject.statements['schema:height']?.[0]?.value.content).toEqual({ amount: '+157', unit: centimetre });
    expect(heroine.subject.statements['schema:name']?.[0]?.value.content).toEqual({ language: 'ja', text: 'Authored heroine' });
    const same = await seed(await currentBindings());
    expect(subjectId(same, 'c1')).toBe(heroineId);
    expect(same.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const association = await candidatePage(typeAId, 'skos:inScheme');
    const associationCandidate = association.candidates.find((item) => item.source)!;
    expect((await editor.http(`/v1/statements/${associationCandidate.id}/retract`, {})).status).toBe(200);
    expect((await currentBindings()).concepts).toEqual([]);
    await seed(await currentBindings());
    expect((await candidatePage(heroineId!, 'wdt:P1853')).candidates.map((item) => item.id)).toEqual(
      bloodCandidates.candidates.map((item) => item.id),
    );
    expect((await read(heroineId!)).subject.statements['wdt:P1853']?.[0]?.value.content).toBe(typeAId);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
