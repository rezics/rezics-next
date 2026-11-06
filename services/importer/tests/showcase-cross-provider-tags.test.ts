import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import { vndbPublicTagScheme, vndbPublicTagTaxonomy } from '@rezics/conversion/vndb-vocabulary';
import {
  bindShowcaseTagParents,
  showcaseTagParentCommand,
  showcaseTagParentMetadata,
  showcaseTagParentSourceFence,
  withholdShowcaseTagAssociations,
} from '../src/showcase-cross-provider-tags.ts';
import { prepareShowcaseTagParentPublications, projectShowcaseTagTables } from '../src/showcase-tags.ts';
import { parseAuthoredVndbCopy } from '../src/vndb-public-tags.ts';
import { emptyCrossMediaPlan, type CrossMediaSeedResult, type CrossMediaTables } from '../src/cross-media-seed.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import { publishShowcase, ShowcaseJournal, type ShowcaseReviewPort } from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { buildShowcaseManifest, showcaseDigest } from '../src/showcase-manifest.ts';

function tables(parents: string[], categories: Record<string, string>): CrossMediaTables {
  const records: Record<string, Record<string, unknown>[]> = {
    tags_vn: [{ tag: 'g1', vid: 'v2002', vote: '3', spoiler: '1', ignore: 'f', lie: 'f' }],
    tags: parseAuthoredVndbCopy(
      'tags',
      'id\tcat\tdefaultspoil\tsearchable\tapplicable\tname\talias\tdescription',
      Object.entries(categories).map(([id, cat]) => `${id}\t${cat}\t0\tt\tt\tSame label\t\\N\t\\N`),
    ),
    tags_parents: parseAuthoredVndbCopy('tags_parents', 'id\tparent\tmain', parents),
  };
  return {
    async *rows(provider, table) {
      if (provider === 'vndb') yield* records[table] ?? [];
    },
  };
}

function bindings(conceptSchemeIds: Record<string, string> = { g1: 'scheme', g2: 'scheme' }): SourceVocabularyBindings {
  return {
    releaseDigest: bundledDigest,
    schemes: [
      {
        taxonomy: vndbPublicTagTaxonomy('cont'),
        id: 'scheme',
        uri: vndbPublicTagScheme('cont'),
        type: 'skos:ConceptScheme',
        releaseDigest: bundledDigest,
      },
    ],
    concepts: Object.entries(conceptSchemeIds).map(([code, schemeId]) => ({
      taxonomy: vndbPublicTagTaxonomy('cont'),
      code,
      id: `native-${code}`,
      type: 'skos:Concept',
      schemeId,
      releaseDigest: bundledDigest,
    })),
  };
}

// These are imported-row controls, not native hierarchy or shared-binding acceptance.
test('selected parent evidence preserves exact source keys and preferred-parent meaning on changed input', async () => {
  const source = tables(['g1\tg2\tf'], { g1: 'cont', g2: 'cont' });
  const first = await projectShowcaseTagTables(source, ['v2002']);
  expect(first.sourceParents).toEqual([
    { child: 'g1', parent: 'g2', main: false, category: 'cont', path: '/tags_parents/g1/g2' },
  ]);
  expect((await projectShowcaseTagTables(source, ['v2002'])).sourceParents).toEqual(first.sourceParents);
  const changed = await projectShowcaseTagTables(tables(['g1\tg3\tt'], { g1: 'cont', g3: 'cont' }), ['v2002']);
  expect(changed.sourceParents).toEqual([
    { child: 'g1', parent: 'g3', main: true, category: 'cont', path: '/tags_parents/g1/g3' },
  ]);
  expect(first.gaps).toEqual([]);
  expect([...(await Array.fromAsync(first.tables.rows('vndb', 'tags_parents')))]).toEqual([]);
});

test('source parent edges resolve by exact current identities and withhold children outside the category Scheme', async () => {
  const projected = await projectShowcaseTagTables(tables(['g1\tg2\tf'], { g1: 'cont', g2: 'cont' }), ['v2002']);
  const resolved = bindShowcaseTagParents({
    sourceParents: projected.sourceParents,
    invalidParentTags: projected.invalidParentTags,
    bindings: bindings(),
  });
  expect(resolved.tagParentEvidence).toEqual([
    expect.objectContaining({
      child: 'g1',
      parent: 'g2',
      main: false,
      path: '/tags_parents/g1/g2',
      childId: 'native-g1',
      parentId: 'native-g2',
      schemeId: 'scheme',
    }),
  ]);
  expect(resolved.unavailableTagCodes).toEqual([]);

  const wrongScheme = bindShowcaseTagParents({
    sourceParents: projected.sourceParents,
    invalidParentTags: projected.invalidParentTags,
    bindings: bindings({ g1: 'scheme', g2: 'another-scheme' }),
  });
  expect(wrongScheme.tagParentEvidence).toEqual([]);
  expect(wrongScheme.unavailableTagCodes).toEqual(['g1']);
  expect(wrongScheme.gaps[0]?.record).toEqual({ id: 'g1', parent: 'g2' });
  expect(
    withholdShowcaseTagAssociations(
      [
        { tag: 'g1', work: 'v2002' },
        { tag: 'g9', work: 'v2002' },
      ],
      wrongScheme.unavailableTagCodes,
    ),
  ).toEqual([{ tag: 'g9', work: 'v2002' }]);

  const manifest = buildShowcaseManifest({
    plan: emptyCrossMediaPlan(),
    readings: [],
    acknowledgements: [],
    aliases: { bangumi: 'bangumi', vndb: 'vndb' },
    tagParentEvidence: resolved.tagParentEvidence,
    tagParentGaps: wrongScheme.gaps,
  });
  expect(manifest.tagParentEvidence).toEqual(resolved.tagParentEvidence);
  expect(manifest.tagParentGaps).toEqual(wrongScheme.gaps);
});

test('a parent proposal cites the exact source path and both bound endpoints without turning main into a qualifier', async () => {
  const projected = await projectShowcaseTagTables(tables(['g1\tg2\tt'], { g1: 'cont', g2: 'cont' }), ['v2002']);
  const [binding] = bindShowcaseTagParents({
    sourceParents: projected.sourceParents,
    invalidParentTags: projected.invalidParentTags,
    bindings: bindings(),
  }).tagParentEvidence;
  expect(binding).toBeDefined();
  const command = JSON.parse(JSON.stringify(showcaseTagParentCommand(binding!))) as ReturnType<
    typeof showcaseTagParentCommand
  >;
  expect(command.subject).toBe(binding!.childId);
  expect(command.source.external_id).toBe('/tags_parents/g1/g2');
  expect(command.source.converter_revision).toBe('vndb-public-tag-vocabulary@2');
  expect(command.statement.property.id).toBe('skos:broader');
  expect(command.statement.value).toEqual({ type: 'value', content: binding!.parentId });
  expect(command.statement.qualifiers).toBeUndefined();
  expect(command.statement.references?.flatMap((reference) => reference.parts.map((part) => part.value))).toEqual([
    { type: 'value', content: `https://vndb.org/${binding!.child}#${binding!.path}` },
    { type: 'value', content: binding!.childUri },
    { type: 'value', content: binding!.parentUri },
  ]);
  expect(command.rights).toBeUndefined();
  expect(
    checkBatchWrite(
      {
        commands: [
          {
            ...command,
            subject: '00000000-0000-4000-8000-000000000001',
            statement: {
              ...command.statement,
              value: { type: 'value', content: '00000000-0000-4000-8000-000000000002' },
            },
          },
        ],
      },
      bundledRelease,
    ),
  ).toEqual([]);
  expect(showcaseTagParentMetadata(binding!)).toMatchObject({
    source: command.source.source,
    external_id: command.source.external_id,
    metadata: { url: 'https://vndb.org/g1#/tags_parents/g1/g2', licence: { id: 'ODbL-1.0' } },
  });

  const seen: unknown[] = [];
  expect(
    await showcaseTagParentSourceFence(async (input) => {
      seen.push(input);
      return { fenced: false, securityRevision: null };
    }, binding!),
  ).toBe('open');
  expect(seen).toEqual([{ source: 'vndb_cross_media', externalId: binding!.path, fieldGroup: 'facts' }]);
  expect(
    await showcaseTagParentSourceFence(async () => ({ fenced: true, securityRevision: 'revoked' }), binding!),
  ).toBe('fenced');
  expect(
    await showcaseTagParentSourceFence(async () => ({ fenced: false, securityRevision: 'unavailable' }), binding!),
  ).toBe('unavailable');

  const acknowledgement = {
    command,
    commandDigest: showcaseDigest(command),
    candidateId: '00000000-0000-4000-8000-000000000001',
  };
  const manifest = buildShowcaseManifest({
    plan: emptyCrossMediaPlan(),
    readings: [],
    acknowledgements: [acknowledgement],
    tagParentAcknowledgements: [acknowledgement],
    tagParentEvidence: [binding!],
    aliases: { bangumi: 'bangumi_cross_media', vndb: 'vndb_cross_media' },
  });
  const child = manifest.vocabulary.find((record) => record.subjectId === binding!.childId);
  expect(child?.provenance).toBe('source-parent-binding');
  expect(child?.assertions).toContainEqual(
    expect.objectContaining({
      tagParentPath: binding!.path,
      property: 'skos:broader',
    }),
  );
  expect(manifest.tagParentPublications).toMatchObject([
    { path: binding!.path, childId: binding!.childId, parentId: binding!.parentId, status: 'proposed' },
  ]);
});

test('missing bound ancestry withholds descendants without matching dictionary labels', async () => {
  const projected = await projectShowcaseTagTables(
    tables(['g1\tg2\tf', 'g2\tg3\tt'], { g1: 'cont', g2: 'cont', g3: 'cont' }),
    ['v2002'],
  );
  const resolved = bindShowcaseTagParents({
    sourceParents: projected.sourceParents,
    invalidParentTags: projected.invalidParentTags,
    bindings: bindings({ g1: 'scheme', g2: 'scheme' }),
  });
  expect(resolved.tagParentEvidence).toEqual([]);
  expect(resolved.unavailableTagCodes).toEqual(['g1', 'g2']);
});

test('a missing ancestor, category crossing or cycle withholds dependent parent evidence despite matching labels', async () => {
  for (const [parents, categories, reason] of [
    [['g1\tg2\tt'], { g1: 'cont' }, 'Missing source tag parent'],
    [['g1\tg2\tt'], { g1: 'cont', g2: 'ero' }, 'crosses Scheme'],
    [['g1\tg2\tt', 'g2\tg3\tt', 'g3\tg2\tf'], { g1: 'cont', g2: 'cont', g3: 'cont' }, 'Cyclic'],
  ] as const) {
    const result = await projectShowcaseTagTables(tables([...parents], categories), ['v2002']);
    expect(result.sourceParents).toEqual([]);
    expect(result.gaps.some((gap) => gap.reason.includes(reason))).toBe(true);
    expect(result.dictionary.has('g1')).toBe(true);
  }
});

test('parent closure stays bounded and excludes ancestry beyond the retained dictionary', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `g${i + 1}`);
  const result = await projectShowcaseTagTables(
    tables(
      ids.slice(0, -1).map((id, i) => `${id}\t${ids[i + 1]}\tt`),
      Object.fromEntries(ids.map((id) => [id, 'cont'])),
    ),
    ['v2002'],
  );
  expect(result.dictionary.size).toBe(9);
  expect(result.sourceParents).toEqual([]);
  expect(result.gaps.some((gap) => gap.reason.includes('Missing source tag parent'))).toBe(true);
});

test('parent publication rereads native metadata before exact proposal replay and stops at its original tuple fence', async () => {
  const projected = await projectShowcaseTagTables(tables(['g1\tg2\tt'], { g1: 'cont', g2: 'cont' }), ['v2002']);
  const [resolved] = bindShowcaseTagParents({
    sourceParents: projected.sourceParents,
    invalidParentTags: [],
    bindings: bindings(),
  }).tagParentEvidence;
  const binding = {
    ...resolved!,
    childId: '00000000-0000-4000-8000-000000000001',
    parentId: '00000000-0000-4000-8000-000000000002',
  };
  const journal = new ShowcaseJournal(':memory:');
  const metadata = sourceRecordMetadataFixture();
  const events: string[] = [];
  let fenced = false;
  const port: Parameters<typeof prepareShowcaseTagParentPublications>[0]['port'] = {
    async fence(input) {
      expect(input).toEqual({ source: 'vndb_cross_media', externalId: binding.path, fieldGroup: 'facts' });
      events.push('fence');
      return { fenced, securityRevision: null };
    },
    async setSourceRecordMetadata(input) {
      events.push('metadata');
      return metadata.setSourceRecordMetadata(input);
    },
    async batch(request) {
      events.push('proposal');
      return {
        results: request.commands.map((command) => {
          const receipt = {
            key: command.key,
            status: 201 as const,
            value: { candidate: '00000000-0000-4000-8000-000000000003', revision: 1 },
          };
          journal.prepareCommand(command);
          journal.acknowledgeCommand(command, receipt);
          return receipt;
        }),
      };
    },
  };
  try {
    const current = showcaseTagParentCommand(binding);
    const old = {
      ...current,
      key: 'sealed-parent-v1',
      source: { ...current.source, converter_revision: 'vndb-public-tag-vocabulary@1' },
      statement: { ...current.statement, references: [{ parts: current.statement.references[0]!.parts.slice(1) }] },
    };
    journal.prepareCommand(old);
    journal.acknowledgeCommand(old, {
      key: old.key,
      status: 201,
      value: { candidate: '00000000-0000-4000-8000-000000000004', revision: 1 },
    });
    const oldBytes = JSON.stringify(journal.acknowledgedCommands()[0]!.command);
    const first = await prepareShowcaseTagParentPublications({ evidence: [binding], port, journal });
    expect(first.gaps).toEqual([]);
    expect(first.acknowledgements).toHaveLength(1);
    expect(events.splice(0)).toEqual(['fence', 'metadata', 'proposal']);
    expect(journal.acknowledgedCommands()).toHaveLength(2);
    expect(JSON.stringify(journal.acknowledgedCommands().find((row) => row.command.key === old.key)!.command)).toBe(
      oldBytes,
    );
    const reopened = await prepareShowcaseTagParentPublications({ evidence: [binding], port, journal });
    expect(reopened.acknowledgements).toEqual(first.acknowledgements);
    expect(events.splice(0)).toEqual(['fence', 'metadata']);
    expect(metadata.requests[1]).toEqual(metadata.requests[0]);
    fenced = true;
    const withdrawn = await prepareShowcaseTagParentPublications({ evidence: [binding], port, journal });
    expect(withdrawn.acknowledgements).toEqual([]);
    expect(withdrawn.unavailableTagCodes).toEqual(['g1']);
    expect(events).toEqual(['fence']);
  } finally {
    journal.close();
  }
});

function emptySeed(plan: ReturnType<typeof emptyCrossMediaPlan>): CrossMediaSeedResult {
  return {
    status: 'imported',
    franchises: plan.franchises,
    members: [],
    runs: {},
    readings: [],
    personIdentities: [],
    canonicalPersons: {},
    mediaOutcomes: [],
    workLinks: [],
    gaps: [],
    creditGaps: [],
    vndbCreditDiagnostics: [],
    vndbCreditVocabularyRequirements: [],
    vndbCreditVocabularyUnavailable: [],
    vndbCharacterProfileRequirements: [],
    vndbCharacterProfileOmissions: [],
    characterDiagnostics: [],
    episodeDiagnostics: [],
    unresolved: [],
    vndbWorkRelations: [],
  };
}

test('parent publication consumes accepted and rejected candidate-page verdicts without replaying accept-action names', async () => {
  const projected = await projectShowcaseTagTables(tables(['g1\tg2\tt'], { g1: 'cont', g2: 'cont' }), ['v2002']);
  const [resolved] = bindShowcaseTagParents({
    sourceParents: projected.sourceParents,
    invalidParentTags: [],
    bindings: bindings(),
  }).tagParentEvidence;
  const schemeId = '00000000-0000-4000-8000-000000000010';
  const childId = '00000000-0000-4000-8000-000000000011';
  const parentId = '00000000-0000-4000-8000-000000000012';
  const candidateId = '00000000-0000-4000-8000-000000000013';
  const binding = { ...resolved!, childId, parentId, schemeId };
  const command = showcaseTagParentCommand(binding);
  const value = (content: string) => [{ value: { type: 'value' as const, content } }];
  type FixtureSubject = {
    subject: {
      id: string;
      type: string;
      statements: Record<string, unknown>;
    };
  };
  const subjects = new Map<string, FixtureSubject>([
    [
      schemeId,
      {
        subject: {
          id: schemeId,
          type: 'skos:ConceptScheme',
          statements: { 'schema:url': value(binding.schemeUri) },
        },
      },
    ],
    [
      childId,
      {
        subject: {
          id: childId,
          type: 'skos:Concept',
          statements: {
            'schema:url': value(binding.childUri),
            'skos:inScheme': value(schemeId),
          },
        },
      },
    ],
    [
      parentId,
      {
        subject: {
          id: parentId,
          type: 'skos:Concept',
          statements: {
            'schema:url': value(binding.parentUri),
            'skos:inScheme': value(schemeId),
          },
        },
      },
    ],
  ]);
  const publishWith = async (decision: 'accepted' | 'rejected') => {
    const journal = new ShowcaseJournal(':memory:');
    const acceptCalls: string[] = [];
    const adoptCalls: string[] = [];
    journal.prepareCommand(command);
    journal.acknowledgeCommand(command, {
      key: command.key,
      status: 201,
      value: { candidate: candidateId, revision: 1 },
    });
    const review: ShowcaseReviewPort = {
      async fence() {
        return { fenced: false, securityRevision: null };
      },
      async readReviewedSubject(id) {
        return subjects.get(id) as never;
      },
      async reviewedCandidates(id, query) {
        expect(id).toBe(childId);
        expect(query.property).toBe('skos:broader');
        return {
          candidates: [
            {
              id: candidateId,
              source: command.source,
              statement: command.statement,
              head: 1,
              decision,
              retracted: null,
              retraction: null,
              release: null,
              revision: 1,
              rank: 'normal',
            },
          ],
          next: null,
          adoption: null,
        } as unknown as Awaited<ReturnType<ShowcaseReviewPort['reviewedCandidates']>>;
      },
      async acceptReviewedCandidate(_id, acceptedId) {
        acceptCalls.push(acceptedId);
        return {
          acceptance: {
            context: '00000000-0000-8000-8000-000000000000',
            candidate: acceptedId,
            decision: 'accept',
            head: 2,
          },
          revision: 2,
        };
      },
      async adoptReviewedCandidates(id, body) {
        adoptCalls.push(id);
        subjects.get(childId)!.subject.statements['skos:broader'] = [command.statement];
        const action = body as {
          context: string;
          property: string;
          mode: 'inherit' | 'replace' | 'suppress';
          selection: { candidate: string; rank: 'normal' | 'preferred' }[];
        };
        return {
          adoption: {
            context: action.context,
            property: action.property,
            mode: action.mode,
            selection: action.selection,
            head: 1,
          },
          revision: 1,
        };
      },
    };
    const publicClient = createPublicBulkClient({
      origin: 'https://fixture.test',
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          const id = new URL(String(input)).pathname.split('/').at(-1)!;
          const subject = subjects.get(id);
          if (!subject) return new Response('missing', { status: 404 });
          return new Response(JSON.stringify(subject), { headers: { 'content-type': 'application/json' } });
        },
        { preconnect: fetch.preconnect },
      ),
    });
    try {
      const plan = emptyCrossMediaPlan();
      const published = await publishShowcase({
        plan,
        result: emptySeed(plan),
        aliases: { bangumi: 'bangumi_cross_media', vndb: 'vndb_cross_media' },
        journal,
        review,
        publicClient,
        tagParentEvidence: [binding],
        tagParentAcknowledgements: journal.acknowledgedCommands(),
      });
      return { published, acceptCalls, adoptCalls };
    } finally {
      journal.close();
    }
  };
  const accepted = await publishWith('accepted');
  expect(accepted.acceptCalls).toEqual([]);
  expect(accepted.adoptCalls).toEqual([childId]);
  expect(accepted.published.manifest.tagParentPublications).toMatchObject([
    { path: binding.path, childId, parentId, status: 'public' },
  ]);
  subjects.get(childId)!.subject.statements = {
    'schema:url': value(binding.childUri),
    'skos:inScheme': value(schemeId),
  };
  const rejected = await publishWith('rejected');
  expect(rejected.acceptCalls).toEqual([]);
  expect(rejected.adoptCalls).toEqual([]);
  expect(rejected.published.manifest.tagParentPublications).toMatchObject([
    { path: binding.path, status: 'withheld', reason: 'parent candidate is rejected' },
  ]);
  expect(rejected.published.omissions).toContainEqual({
    provider: 'vndb',
    sourceKey: binding.path,
    code: 'candidate-currently-rejected',
  });
});
