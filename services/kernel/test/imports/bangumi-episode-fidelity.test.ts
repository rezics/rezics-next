import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { documentText, parseDocument } from '@rezics/document';
import {
  episodeTypeConceptUri,
  episodeTypeSchemeUri,
  importBangumiEpisodeFidelity,
  readEpisodeTypeBindings,
} from '../../../importer/src/bangumi-episode-fidelity.ts';
import { crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

function tables(episodes: Record<string, unknown>[]) {
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider === 'bangumi' && table === 'subject') yield { id: 81, type: 2, name: 'Authored series' };
      if (provider === 'bangumi' && table === 'episode') yield* episodes;
    },
  };
}

const baseEpisodes = [
  {
    id: 900001,
    subject_id: 81,
    name: 'Authored fractional episode',
    sort: 1.5,
    type: 0,
    airdate: '2006-04-06',
    duration: '24m',
    description: 'Authored CC-BY-SA episode description.',
    disc: 3,
  },
  {
    id: 900002,
    subject_id: 81,
    name: 'Authored special',
    sort: 0,
    type: 1,
    duration: 'PT5M',
  },
  {
    id: 900003,
    subject_id: 81,
    name: 'Authored unknown kind',
    sort: 2,
    type: 99,
    duration: 'two reels',
  },
];

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred'; references?: unknown[] };
  source?: unknown;
};

test('production operator imports authored Bangumi episodes through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-episode-native-'));
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
    const schemeCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: 'authored-episode-type-scheme',
          source: {
            source: 'authored-episode-types',
            external_id: 'scheme',
            record_revision: 'unversioned',
            digest: 'a'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Authored Bangumi episode types' } },
        },
      ],
    });
    expect(schemeCreated.results[0]?.status).toBe(201);
    const schemeId = (schemeCreated.results[0] as { value: { id: string } }).value.id;
    const specialCreated = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: 'authored-episode-type-special',
          source: {
            source: 'authored-episode-types',
            external_id: 'special',
            record_revision: 'unversioned',
            digest: 'b'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: { type: 'skos:Concept', labels: { en: 'Special' } },
        },
      ],
    });
    expect(specialCreated.results[0]?.status).toBe(201);
    const specialId = (specialCreated.results[0] as { value: { id: string } }).value.id;
    const propose = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: 'authored-scheme-url',
          source: {
            source: 'authored-episode-types',
            external_id: 'scheme',
            record_revision: 'unversioned',
            digest: 'a'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: schemeId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: episodeTypeSchemeUri },
            references: [
              { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: episodeTypeSchemeUri } }] },
            ],
          },
        },
        {
          op: 'propose',
          key: 'authored-special-url',
          source: {
            source: 'authored-episode-types',
            external_id: 'special',
            record_revision: 'unversioned',
            digest: 'b'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: specialId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: episodeTypeConceptUri('1') },
            references: [
              {
                parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: episodeTypeConceptUri('1') } }],
              },
            ],
          },
        },
        {
          op: 'propose',
          key: 'authored-special-scheme',
          source: {
            source: 'authored-episode-types',
            external_id: 'special',
            record_revision: 'unversioned',
            digest: 'b'.repeat(64),
            converter_revision: 'authored@1',
            field_group: 'facts',
          },
          subject: specialId,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: schemeId },
            references: [
              {
                parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: episodeTypeConceptUri('1') } }],
              },
            ],
          },
        },
      ],
    });
    expect(propose.results.every((result) => result.status === 201)).toBe(true);
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
    await acceptAdopt(schemeId, 'schema:url');
    await acceptAdopt(specialId, 'schema:url');
    await acceptAdopt(specialId, 'skos:inScheme');
    const bindings = await readEpisodeTypeBindings(runtime.importTransport, {
      schemeId,
      concepts: [{ code: '1', id: specialId }],
    });
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((item) => item.id)).toEqual([specialId]);
    const path = join(directory, 'state.sqlite');
    const first = await importBangumiEpisodeFidelity({
      tables: tables(baseEpisodes),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const fractional = first.readings.find((row) => row.externalId === 'episode:900001');
    const special = first.readings.find((row) => row.externalId === 'episode:900002');
    const unknown = first.readings.find((row) => row.externalId === 'episode:900003');
    const parent = first.readings.find((row) => row.externalId === '81');
    expect(fractional && special && unknown && parent).toBeTruthy();
    const fractionalId = (fractional!.subject as { subject?: { id: string } }).subject?.id ?? (fractional!.subject as { id?: string }).id;
    const specialEpisodeId =
      (special!.subject as { subject?: { id: string } }).subject?.id ?? (special!.subject as { id?: string }).id;
    const unknownId = (unknown!.subject as { subject?: { id: string } }).subject?.id ?? (unknown!.subject as { id?: string }).id;
    const parentId = (parent!.subject as { subject?: { id: string } }).subject?.id ?? (parent!.subject as { id?: string }).id;
    expect(fractionalId && specialEpisodeId && unknownId && parentId).toBeTruthy();
    expect(fractionalId).not.toBe(specialEpisodeId);
    for (const property of ['schema:episodeNumber', 'schema:datePublished', 'schema:duration', 'schema:abstract', 'schema:isPartOf'])
      await acceptAdopt(fractionalId!, property);
    await acceptAdopt(specialEpisodeId!, 'schema:keywords');
    await acceptAdopt(specialEpisodeId!, 'schema:isPartOf');
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as { subject: { type: string; statements: Record<string, { value: { content: unknown } }[]> } };
    };
    const current = await read(fractionalId!);
    expect(current.subject.type).toBe('schema:Episode');
    expect(current.subject.statements['schema:episodeNumber']?.map((item) => item.value.content)).toEqual(['1.5']);
    expect(current.subject.statements['schema:isPartOf']?.map((item) => item.value.content)).toEqual([parentId]);
    const published = current.subject.statements['schema:datePublished']?.[0]?.value.content as { precision: number };
    expect(published.precision).toBe(11);
    expect(current.subject.statements['schema:duration']?.[0]?.value.content).toEqual({
      amount: '+1440',
      unit: 'http://www.wikidata.org/entity/Q11574',
    });
    const abstract = current.subject.statements['schema:abstract']?.[0]?.value.content as { document: unknown };
    expect(documentText(parseDocument(abstract.document))).toBe('Authored CC-BY-SA episode description.');
    const specialView = await read(specialEpisodeId!);
    expect(specialView.subject.statements['schema:keywords']?.map((item) => item.value.content)).toEqual([specialId]);
    const unknownView = await read(unknownId!);
    expect(unknownView.subject.statements['schema:keywords'] ?? []).toEqual([]);
    expect(unknownView.subject.statements['schema:duration'] ?? []).toEqual([]);
    const again = await importBangumiEpisodeFidelity({
      tables: tables(baseEpisodes),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(again.readings.map((row) => row.externalId).sort()).toEqual(first.readings.map((row) => row.externalId).sort());
    const changed = structuredClone(baseEpisodes);
    changed[0] = { ...changed[0]!, airdate: '2006-04-07' };
    const successor = await importBangumiEpisodeFidelity({
      tables: tables(changed),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(successor.runs.bangumi?.counts.changed).toBeGreaterThan(0);
    const page = await editor.http(
      `/v1/subjects/${fractionalId}/candidates?${new URLSearchParams({ property: 'schema:datePublished', context: globalContext, limit: '100' })}`,
    );
    const dates = (page.body as { candidates: Candidate[] }).candidates.map((item) => item.statement.value.content);
    expect(dates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ time: '+2006-04-06T00:00:00Z' }),
        expect.objectContaining({ time: '+2006-04-07T00:00:00Z' }),
      ]),
    );
    const specialUrlPage = await editor.http(
      `/v1/subjects/${specialId}/candidates?${new URLSearchParams({ property: 'schema:url', context: globalContext, limit: '100' })}`,
    );
    const specialUrl = (specialUrlPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    const retracted = await editor.http(`/v1/statements/${specialUrl.id}/retract`, {});
    expect(retracted.status).toBe(200);
    const withheldBindings = await readEpisodeTypeBindings(runtime.importTransport, {
      schemeId,
      concepts: [{ code: '1', id: specialId }],
    });
    expect(withheldBindings.concepts).toEqual([]);
    await importBangumiEpisodeFidelity({
      tables: tables(baseEpisodes),
      path,
      port: runtime.importTransport,
      bindings: withheldBindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const kindPage = await editor.http(
      `/v1/subjects/${specialEpisodeId}/candidates?${new URLSearchParams({ property: 'schema:keywords', context: globalContext, limit: '100' })}`,
    );
    const kindCandidates = (kindPage.body as { candidates: Candidate[] }).candidates.filter((item) => !item.retracted);
    expect(kindCandidates.filter((item) => item.statement.value.content === specialId).length).toBeLessThanOrEqual(1);
    await editor.takedown(crossMediaAliases.bangumi, 'episode:900001', 'summary');
    const restored = structuredClone(baseEpisodes);
    restored[0] = { ...restored[0]!, description: 'Restored description after fence.' };
    await importBangumiEpisodeFidelity({
      tables: tables(restored),
      path,
      port: runtime.importTransport,
      bindings: withheldBindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const summaryPage = await editor.http(
      `/v1/subjects/${fractionalId}/candidates?${new URLSearchParams({ property: 'schema:abstract', context: globalContext, limit: '100' })}`,
    );
    const texts = (summaryPage.body as { candidates: Candidate[] }).candidates.map((item) => {
      const content = item.statement.value.content as { document?: unknown };
      return content.document ? documentText(parseDocument(content.document)) : '';
    });
    expect(texts).not.toContain('Restored description after fence.');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
