import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  episodeTypeConceptUri,
  episodeTypeSchemeUri,
} from '../../../importer/src/bangumi-episode-fidelity.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
} from '../../../importer/src/cross-media-seed.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const context = GLOBAL_CONTEXT;
const episodes = [
  { id: 900001, subject_id: 81, name: 'Main episode', sort: 1.5, type: 0 },
  { id: 900002, subject_id: 81, name: 'Fractional special', sort: 0, type: 1 },
];

function tables() {
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 81, type: 2, name: 'STEINS;GATE' };
        yield { id: 82, type: 2, name: 'CLANNAD' };
        yield { id: 83, type: 2, name: 'Fate/stay night' };
      }
      if (provider === 'bangumi' && table === 'episode') yield* episodes;
      if (provider === 'vndb' && table === 'vn_titles') {
        yield { id: 'v81', lang: 'ja', title: 'STEINS;GATE', latin: 'STEINS;GATE', official: 't' };
        yield { id: 'v82', lang: 'ja', title: 'CLANNAD', latin: 'CLANNAD', official: 't' };
        yield { id: 'v83', lang: 'ja', title: 'Fate/stay night', latin: 'Fate/stay night', official: 't' };
      }
      if (provider === 'vndb' && table === 'vn') {
        yield { id: 'v81', olang: 'ja', alias: null };
        yield { id: 'v82', olang: 'ja', alias: null };
        yield { id: 'v83', olang: 'ja', alias: null };
      }
      if (provider === 'vndb' && table === 'entry_meta') {
        yield { id: 'v81', revision: '1', lastmod: '2026-11-01' };
        yield { id: 'v82', revision: '1', lastmod: '2026-11-01' };
        yield { id: 'v83', revision: '1', lastmod: '2026-11-01' };
      }
    },
  };
}

type Candidate = {
  id: string;
  head: number | null;
  statement: { rank?: 'normal' | 'preferred'; value: { content: unknown } };
};

function identity(reading: Awaited<ReturnType<typeof seedCrossMedia>>['readings'][number]): string {
  const value = reading.subject as { subject?: { id?: string }; id?: string };
  return value.subject?.id ?? value.id ?? '';
}

test('default seed exposes adopted Episode kind and exact parent, then rechecks a retracted binding without new identity', async () => {
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpdir();
  let runtime: Awaited<ReturnType<typeof openApiRuntime>> | undefined;
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-episodes-native-'));
  try {
    runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: context },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const createSource = (externalId: string): BatchCommand['source'] => ({
      source: 'reviewed-episode-types',
      external_id: externalId,
      record_revision: 'unversioned',
      digest: digest(externalId),
      converter_revision: 'reviewed-episode-types@1',
      field_group: 'facts',
    });
    const created = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: 'showcase-episode-scheme',
          source: createSource('scheme'),
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Bangumi episode types' } },
        },
        ...(['0', '1'] as const).map((code) => ({
          op: 'create' as const,
          key: `showcase-episode-type-${code}`,
          source: createSource(`type:${code}`),
          subject: { type: 'skos:Concept', labels: { en: code === '0' ? 'Main episode' : 'Special' } },
        })),
      ],
    });
    expect(created.results.every((item) => item.status === 201)).toBe(true);
    const idAt = (index: number) => {
      const receipt = created.results[index];
      if (!receipt || !('value' in receipt) || !('id' in receipt.value))
        throw new Error('Missing acknowledged reviewed subject identity');
      return receipt.value.id;
    };
    const schemeId = idAt(0);
    const type0Id = idAt(1);
    const type1Id = idAt(2);
    const typeUris = new Map([
      [type0Id, episodeTypeConceptUri('0')],
      [type1Id, episodeTypeConceptUri('1')],
    ]);
    const proposals: BatchCommand[] = [
      {
        op: 'propose',
        key: 'showcase-episode-scheme-url',
        source: createSource('scheme'),
        subject: schemeId,
        statement: {
          property: { id: 'schema:url' },
          value: { type: 'value', content: episodeTypeSchemeUri },
          references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: episodeTypeSchemeUri } }] }],
        },
      },
      ...[...typeUris].flatMap(([id, uri], index) => [
        {
          op: 'propose' as const,
          key: `showcase-episode-type-url-${index}`,
          source: createSource(`type:${index}`),
          subject: id,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value' as const, content: uri },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: uri } }] }],
          },
        },
        {
          op: 'propose' as const,
          key: `showcase-episode-type-scheme-${index}`,
          source: createSource(`type:${index}`),
          subject: id,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value' as const, content: schemeId },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: uri } }] }],
          },
        },
      ]),
    ];
    const proposed = await runtime.importTransport.batch({ commands: proposals });
    expect(proposed.results.every((item) => item.status === 201)).toBe(true);

    async function acceptAdopt(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const candidate = listing.candidates.find((item) => item.id) ?? listing.candidates[0]!;
      const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
        context,
        expected_head: candidate.head,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
      });
      expect(adopted.status).toBe(200);
    }
    await acceptAdopt(schemeId, 'schema:url');
    for (const id of [type0Id, type1Id]) {
      await acceptAdopt(id, 'schema:url');
      await acceptAdopt(id, 'skos:inScheme');
    }

    const plan = await planCrossMediaSeed(tables());
    const deliveryKeys = new Set(['81', ...episodes.map((episode) => `episode:${episode.id}`)]);
    plan.records.bangumi = plan.records.bangumi.filter((record) => deliveryKeys.has(record.key));
    plan.entities.bangumi = plan.entities.bangumi.filter((record) => deliveryKeys.has(record.key));
    plan.records.vndb = [];
    plan.entities.vndb = [];
    plan.edges = plan.edges.filter((edge) => edge.holder.startsWith('episode:'));
    plan.credits = [];
    const state = join(directory, 'state.sqlite');
    const manifest = {
      'bangumi-episode-types-scheme': schemeId,
      'bangumi-episode-type-0': type0Id,
      'bangumi-episode-type-1': type1Id,
    };
    const seed = () =>
      seedCrossMedia(
        plan,
        state,
        runtime!.importTransport,
        { origin: 'https://kernel.import.test' },
        { episodeCatalogueSubjects: manifest, providers: ['bangumi'] },
      );
    const first = await seed();
    const firstEpisode = first.readings.find((reading) => reading.externalId === 'episode:900002');
    const parent = first.readings.find((reading) => reading.externalId === '81');
    expect(firstEpisode && parent).toBeTruthy();
    const episodeId = identity(firstEpisode!);
    const parentId = identity(parent!);
    expect(episodeId && parentId && episodeId !== parentId).toBe(true);

    await acceptAdopt(episodeId, 'schema:keywords');
    await acceptAdopt(episodeId, 'schema:isPartOf');
    const current = await editor.http(`/v1/subjects/${episodeId}?context=${context}`);
    expect(current.status).toBe(200);
    const currentSubject = (current.body as {
      subject: { type: string; statements: Record<string, { value: { content: unknown } }[]> };
    }).subject;
    expect(currentSubject.type).toBe('schema:Episode');
    expect(currentSubject.statements['schema:keywords']?.map((item) => item.value.content)).toEqual([type1Id]);
    expect(currentSubject.statements['schema:isPartOf']?.map((item) => item.value.content)).toEqual([parentId]);
    const currentBinding = await editor.http(
      `/v1/subjects/${type1Id}/candidates?${new URLSearchParams({ property: 'schema:url', context, limit: '100' })}`,
    );
    const urlCandidate = (currentBinding.body as { candidates: Candidate[] }).candidates[0]!;
    const retracted = await editor.http(`/v1/statements/${urlCandidate.id}/retract`, {});
    expect(retracted.status).toBe(200);

    const refreshed = await seed();
    const refreshedEpisode = refreshed.readings.find((reading) => reading.externalId === 'episode:900002');
    expect(identity(refreshedEpisode!)).toBe(episodeId);
    expect(refreshed.episodeDiagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: 'episode:900002', reason: 'unbound_concept' }),
    );
    const finalRead = await editor.http(`/v1/subjects/${episodeId}?context=${context}`);
    const finalSubject = (finalRead.body as {
      subject: { statements: Record<string, { value: { content: unknown } }[]> };
    }).subject;
    expect(finalSubject.statements['schema:keywords']?.map((item) => item.value.content)).toEqual([type1Id]);
    expect(finalSubject.statements['schema:isPartOf']?.map((item) => item.value.content)).toEqual([parentId]);
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
}, 180_000);
