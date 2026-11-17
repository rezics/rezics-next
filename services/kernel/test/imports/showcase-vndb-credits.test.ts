import type { ApiRuntimeFailure } from './api-runtime-support.ts';
import { expect, test } from 'bun:test';
import { createImportTransport, type ReviewedCandidatePage } from '../../../importer/src/import-client.ts';
import { currentCandidates, fixtureFetch, valueContent } from './type-helpers.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossMediaAliases, planCrossMediaSeed, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import type { ShowcaseAssertion } from '../../../importer/src/showcase-contract.ts';
import { creditSlot, statementOnPublicRead } from '../../../importer/src/showcase-current-reads.ts';
import {
  prepareShowcaseVndbCreditVocabulary,
  publishedShowcaseVndbCreditReferences,
} from '../../../importer/src/showcase-vndb-credits.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import {
  creditTypeTaxonomy,
  readCreditTypeBindingsDetailed,
  vndbStaffCreditConverterRevision,
} from '../../../importer/src/vndb-staff-credits.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

type Candidate = Exclude<ReviewedCandidatePage['candidates'][number], { deleted: true }>;

function selectedVn(voiceAliasId = '10') {
  const bangumiRows: Record<string, Record<string, unknown>[]> = {
    subject: [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
  };
  const rows: Record<string, Record<string, unknown>[]> = {
    vn: [
      { id: 'v1', olang: 'ja', alias: null },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    vn_titles: [
      { id: 'v1', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    entry_meta: [
      { id: 'v1', revision: '7', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v2', revision: '8', lastmod: '2026-10-25 00:00:00+00' },
      { id: 'v3', revision: '9', lastmod: '2026-10-25 00:00:00+00' },
    ],
    vn_staff: [
      { id: 'v1', aid: '10', role: 'scenario', note: 'Common route, After Story routes' },
      { id: 'v1', aid: '10', role: 'scenario', eid: '5', note: 'Additional source staff grouping' },
      { id: 'v1', aid: '20', role: 'chardesign', note: 'Original character designs' },
    ],
    vn_seiyuu: [{ id: 'v1', aid: voiceAliasId, cid: 'c3', note: 'Voice Alias' }],
    staff_alias: [
      { id: 's4', aid: '10', name: 'Writer Alias' },
      { id: 's4', aid: '20', name: 'Artist Alias' },
      ...(voiceAliasId === '30' ? [{ id: 's5', aid: '30', name: 'Corrected Voice Alias' }] : []),
    ],
    staff: [
      { id: 's4', main: '10', prod: null },
      ...(voiceAliasId === '30' ? [{ id: 's5', main: '30', prod: null }] : []),
    ],
    chars: [{ id: 'c3', main: null, name: 'Authored character' }],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* (provider === 'vndb' ? rows[table] : bangumiRows[table]) ?? [];
    },
  };
}

test('selected-VN credits reach adopted current facts through exact current bindings and reopen', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'showcase-vndb-credits-native-'));
  let journal: ShowcaseJournal | undefined;
  let failure: ApiRuntimeFailure | undefined;
  try {
    const tierKey = randomUUID();
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: tierKey, tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
      tierKey,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const review = createImportTransport({
      origin: runtime.origin,
      tokenProvider: async () => editor.bearer,
      fetch: fixtureFetch(async (input, init) => runtime.replay(new Request(input, init))),
    });

    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(String(input));
          return runtime.request(`${url.pathname}${url.search}`);
        },
        { preconnect() {} },
      ),
    });
    const read = async (id: string) => (await publicClient.readSubject(id)).subject;
    async function currentSchemeIds(conceptId: string) {
      const concept = await read(conceptId);
      expect(concept.id).toBe(conceptId);
      expect(concept.type).toBe('skos:Concept');
      return (concept.statements['skos:inScheme'] ?? [])
        .filter((statement) => statement.rank === 'normal' || statement.rank === 'preferred')
        .map((statement) => valueContent(statement.value));
    }

    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    let port = captureShowcaseCommands(runtime.importTransport, journal);
    const plan = await planCrossMediaSeed(selectedVn());
    const statePath = join(directory, 'state.sqlite');
    const destination = { origin: runtime.origin };
    let result = await seedCrossMedia(plan, statePath, port, destination, { mediaDeadlineMs: 0 });

    async function reviewSlot(subjectId: string, property: string, slot?: ReturnType<typeof creditSlot>) {
      const listing = await review.reviewedCandidates(subjectId, {
        property,
        ...slot,
        context: GLOBAL_CONTEXT,
        limit: 100,
      });
      expect(listing.next).toBeNull();
      return { ...listing, candidates: currentCandidates(listing.candidates) };
    }

    async function adoptVocabularyCandidate(
      subjectId: string,
      property: string,
      matches: (candidate: Candidate) => boolean,
    ) {
      const { candidates, adoption } = await reviewSlot(subjectId, property);
      const candidate = candidates.find(matches);
      if (!candidate?.source) throw new Error(`Expected source candidate for ${property} on ${subjectId}`);
      await acceptAndAdopt(subjectId, property, candidate, adoption?.head ?? null);
    }

    async function acceptAndAdopt(
      subjectId: string,
      property: string,
      candidate: Candidate,
      adoptionHead: number | null,
      slot?: ReturnType<typeof creditSlot>,
    ) {
      expect(candidate.retracted).toBeNull();
      const accepted = await review.acceptReviewedCandidate(
        subjectId,
        candidate.id,
        { context: GLOBAL_CONTEXT, expected_head: candidate.head },
        randomUUID(),
      );
      expect(accepted.acceptance.candidate).toBe(candidate.id);
      const selection = [{ candidate: candidate.id, rank: 'normal' as const }];
      const adopted = await review.adoptReviewedCandidates(
        subjectId,
        { ...slot, context: GLOBAL_CONTEXT, property, mode: 'replace', expected_head: adoptionHead, selection },
        randomUUID(),
      );
      expect(adopted.adoption.selection).toEqual(selection);
    }

    async function adoptCredit(workId: string, assertion: ShowcaseAssertion, target: string, key?: string) {
      const slot = creditSlot(assertion.statement);
      expect(slot).toEqual({ target, ...(key === undefined ? {} : { key }) });
      const { candidates, adoption } = await reviewSlot(workId, assertion.property, slot);
      const candidate = candidates.find((row) => row.id === assertion.candidateId);
      if (!candidate) throw new Error(`Expected sealed ${assertion.property} candidate ${assertion.candidateId}`);
      expect(candidate.source).toEqual(assertion.source);
      expect(statementOnPublicRead(candidate.statement, assertion.statement)).toBe(true);
      await acceptAndAdopt(workId, assertion.property, candidate, adoption?.head ?? null, slot);
    }

    function expectPublicCredit(work: Awaited<ReturnType<typeof read>>, assertion: ShowcaseAssertion) {
      const statement = work.statements[assertion.property]?.find((row) => row.id === assertion.candidateId);
      expect(statement?.rank).toBe('normal');
      expect(statementOnPublicRead(statement, assertion.statement)).toBe(true);
    }

    function acknowledgedCreate(externalId: string): string {
      const entry = journal!
        .acknowledgedCommands()
        .find(
          (acknowledgement) =>
            acknowledgement.command.op === 'create' && acknowledgement.command.source.external_id === externalId,
        );
      expect(entry?.subjectId).toBeTruthy();
      if (!entry?.subjectId) throw new Error(`Expected acknowledged source identity for ${externalId}`);
      return entry.subjectId;
    }

    const schemes = await prepareShowcaseVndbCreditVocabulary({ plan, port, journal, stage: 'schemes' });
    expect(schemes.requirements).toHaveLength(1);
    await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: schemes.requirements,
    });
    const schemeRequirement = schemes.requirements[0]!;
    const schemeId = acknowledgedCreate(schemeRequirement.source.external_id);
    await adoptVocabularyCandidate(
      schemeId,
      'schema:url',
      (candidate) => valueContent(candidate.statement.value) === schemeRequirement.sourceUri,
    );

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const concepts = await prepareShowcaseVndbCreditVocabulary({ plan, port, journal, stage: 'concepts' });
    const conceptRequirements = concepts.requirements.filter(
      (requirement) => requirement.nativeType === 'skos:Concept',
    );
    expect(conceptRequirements.map((requirement) => requirement.sourceKey)).toEqual([
      'vndb.credit_type:chardesign',
      'vndb.credit_type:scenario',
    ]);
    const completeConceptPublication = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });

    const designRequirement = conceptRequirements.find((requirement) => requirement.sourceKey.endsWith(':chardesign'))!;
    const designId = acknowledgedCreate(designRequirement.source.external_id);
    const scenarioCreateId = acknowledgedCreate(
      conceptRequirements.find((requirement) => requirement.sourceKey === `${creditTypeTaxonomy}:scenario`)!.source
        .external_id,
    );
    const completeReferences = publishedShowcaseVndbCreditReferences(
      completeConceptPublication,
      journal,
      concepts.requirements,
    );
    expect(completeReferences).toEqual({
      schemeId,
      concepts: [
        { code: 'chardesign', id: designId },
        { code: 'scenario', id: scenarioCreateId },
      ],
    });
    if (!completeReferences) throw new Error('Expected both role bindings before changing the design Scheme');

    const authored = {
      source: 'authored-vndb-credit-types',
      record_revision: 'unversioned',
      converter_revision: 'authored@1',
      field_group: 'facts' as const,
    };
    const wrongSchemeResult = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: `wrong-vndb-credit-scheme:${randomUUID()}`,
          source: { ...authored, external_id: 'wrong-vndb-credit-scheme', digest: 'f'.repeat(64) },
          subject: { type: 'skos:ConceptScheme', labels: { en: 'Other VNDB roles' } },
        },
      ],
    });
    expect(wrongSchemeResult.results[0]?.status).toBe(201);
    const wrongSchemeId = (wrongSchemeResult.results[0] as { value: { id: string } }).value.id;
    const wrongBinding = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: `wrong-vndb-credit-binding:${randomUUID()}`,
          source: designRequirement.source,
          subject: designId,
          statement: {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: wrongSchemeId },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: designRequirement.sourceUri },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    const wrongCandidate = wrongBinding.results[0];
    expect(wrongCandidate?.status).toBe(201);
    if (!wrongCandidate || !('value' in wrongCandidate) || !('candidate' in wrongCandidate.value))
      throw new Error('Expected the acknowledged wrong-Scheme candidate');
    const wrongCandidateId = wrongCandidate.value.candidate;

    for (const requirement of conceptRequirements) {
      const subjectId = acknowledgedCreate(requirement.source.external_id);
      await adoptVocabularyCandidate(
        subjectId,
        'schema:url',
        (candidate) => valueContent(candidate.statement.value) === requirement.sourceUri,
      );
      await adoptVocabularyCandidate(subjectId, 'skos:inScheme', (candidate) =>
        subjectId === designId ? candidate.id === wrongCandidateId : valueContent(candidate.statement.value) === schemeId,
      );
    }

    expect(await currentSchemeIds(designId)).toEqual([wrongSchemeId]);
    const rereadBindings = await readCreditTypeBindingsDetailed(port, completeReferences, (id) =>
      publicClient.readSubject(id),
    );
    expect(rereadBindings.bindings.concepts.map(({ code, id }) => ({ code, id }))).toEqual([
      { code: 'scenario', id: scenarioCreateId },
    ]);
    expect(rereadBindings.unavailable).toEqual([]);

    const vocabularyAcks = journal.acknowledgedCommands().length;
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const reopenedConcepts = await prepareShowcaseVndbCreditVocabulary({ plan, port, journal, stage: 'concepts' });
    expect(journal.acknowledgedCommands()).toHaveLength(vocabularyAcks);
    expect(reopenedConcepts.requirements).toEqual(concepts.requirements);
    const selectedReviewRequirements = reopenedConcepts.requirements.filter(
      (requirement) =>
        requirement.sourceKey === creditTypeTaxonomy || requirement.sourceKey === `${creditTypeTaxonomy}:scenario`,
    );
    expect(selectedReviewRequirements.map((requirement) => requirement.sourceKey)).toEqual([
      creditTypeTaxonomy,
      `${creditTypeTaxonomy}:scenario`,
    ]);

    let vocabularyPublication = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: selectedReviewRequirements,
    });
    expect(await currentSchemeIds(designId)).toEqual([wrongSchemeId]);
    const publishedReferences = publishedShowcaseVndbCreditReferences(
      vocabularyPublication,
      journal,
      reopenedConcepts.requirements,
    );
    expect(publishedReferences).toBeDefined();
    if (!publishedReferences) throw new Error('Expected current published VNDB credit bindings');
    const references = publishedReferences;
    const scenarioId = references.concepts.find((concept) => concept.code === 'scenario')!.id;
    expect(scenarioId).toBe(scenarioCreateId);
    expect(references).toEqual({
      schemeId,
      concepts: [
        {
          code: 'scenario',
          id: acknowledgedCreate(
            conceptRequirements.find((requirement) => requirement.sourceKey.endsWith(':scenario'))!.source.external_id,
          ),
        },
      ],
    });

    const first = await seedCrossMedia(plan, statePath, port, destination, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: (id) => publicClient.readSubject(id),
    });
    expect(first.vndbCreditDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'chardesign', reason: 'missing_concept' }),
    );
    const identities = new Map(first.readings.map((row) => [row.externalId, row.subject.subject.id]));
    for (const key of ['v1', 's4', 'c3'])
      expect(identities.get(key), `Current native VNDB identity ${key} is absent from the seed readings`).toBeTruthy();
    const workId = identities.get('v1')!;
    const personId = identities.get('s4')!;
    const characterId = identities.get('c3')!;
    expect(workId && personId && characterId).toBeTruthy();

    const pendingPublication = await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: selectedReviewRequirements,
    });
    const pendingCredits = pendingPublication.manifest.records
      .find((record) => record.sourceKey === 'v1')!
      .assertions.filter((assertion) => assertion.source.converter_revision === vndbStaffCreditConverterRevision);
    expect(pendingCredits.map((assertion) => assertion.property).sort()).toEqual(['schema:author', 'wdt:P725']);
    const oldVoice = pendingCredits.find((assertion) => assertion.property === 'wdt:P725')!;
    expect(valueContent(oldVoice.statement.value)).toBe(personId);
    expect(oldVoice.citations).toContain('https://vndb.org/v1#/vn_seiyuu/v1/10/c3');
    await adoptCredit(workId, oldVoice, personId, characterId);
    expectPublicCredit(await read(workId), oldVoice);

    const creditProposalKeys = () =>
      journal!
        .acknowledgedCommands()
        .filter(
          ({ command }) =>
            command.op === 'propose' && command.source.converter_revision === vndbStaffCreditConverterRevision,
        )
        .map(({ command }) => command.key)
        .sort();
    const pendingCreditKeys = creditProposalKeys();
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const replay = await seedCrossMedia(plan, statePath, port, destination, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: (id) => publicClient.readSubject(id),
    });
    expect(creditProposalKeys()).toEqual(pendingCreditKeys);
    expect(new Map(replay.readings.map((row) => [row.externalId, row.subject.subject.id])).get('v1')).toBe(workId);
    expectPublicCredit(await read(workId), oldVoice);

    const correctedPlan = await planCrossMediaSeed(selectedVn('30'));
    result = await seedCrossMedia(correctedPlan, statePath, port, destination, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: (id) => publicClient.readSubject(id),
    });
    expect(result.vndbCreditDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'chardesign', reason: 'missing_concept' }),
    );
    await publishShowcase({
      plan: correctedPlan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: selectedReviewRequirements,
    });
    result = await seedCrossMedia(correctedPlan, statePath, port, destination, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: (id) => publicClient.readSubject(id),
    });
    const correctedIdentities = new Map(result.readings.map((row) => [row.externalId, row.subject.subject.id]));
    const correctedVoiceId = correctedIdentities.get('s5')!;
    expect(correctedIdentities.get('v1')).toBe(workId);
    expect(correctedIdentities.get('s4')).toBe(personId);
    expect(correctedIdentities.get('c3')).toBe(characterId);
    expect(correctedVoiceId).toBeTruthy();

    vocabularyPublication = await publishShowcase({
      plan: correctedPlan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: selectedReviewRequirements,
    });
    const currentCredits = vocabularyPublication.manifest.records
      .find((record) => record.sourceKey === 'v1')!
      .assertions.filter((assertion) => assertion.source.converter_revision === vndbStaffCreditConverterRevision);
    expect(currentCredits.map((assertion) => assertion.property).sort()).toEqual(['schema:author', 'wdt:P725']);
    const author = currentCredits.find((assertion) => assertion.property === 'schema:author')!;
    const voice = currentCredits.find((assertion) => assertion.property === 'wdt:P725')!;
    expect(valueContent(author.statement.value)).toBe(personId);
    expect(valueContent(voice.statement.value)).toBe(correctedVoiceId);
    expect(voice.candidateId).not.toBe(oldVoice.candidateId);
    expect(author.statement.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P3831' }, value: { content: scenarioId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Writer Alias' } }),
      ]),
    );
    expect(voice.statement.qualifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: { id: 'wdt:P453' }, value: { content: characterId } }),
        expect.objectContaining({ property: { id: 'wdt:P1932' }, value: { content: 'Corrected Voice Alias' } }),
      ]),
    );
    expect(author.citations).toContain('https://vndb.org/v1#/vn_staff/v1/10/scenario');
    expect(voice.citations).toContain('https://vndb.org/v1#/vn_seiyuu/v1/30/c3');
    await adoptCredit(workId, author, personId);
    await adoptCredit(workId, voice, correctedVoiceId, characterId);

    const oldVoiceSlot = await reviewSlot(workId, 'wdt:P725', creditSlot(oldVoice.statement));
    const withdrawnVoice = oldVoiceSlot.candidates.find((candidate) => candidate.id === oldVoice.candidateId);
    expect(withdrawnVoice).toMatchObject({
      source: oldVoice.source,
      retracted: expect.any(Number),
      retraction: {
        source: { source: oldVoice.source.source, external_id: 'v1', field_group: 'facts' },
      },
    });
    expect(withdrawnVoice?.retraction?.references).toEqual(oldVoice.statement.references);

    await publishShowcase({
      plan: correctedPlan,
      result,
      aliases: crossMediaAliases,
      journal,
      review,
      publicClient,
      vocabularyRequirements: selectedReviewRequirements,
    });
    const current = await read(workId);
    expectPublicCredit(current, author);
    expectPublicCredit(current, voice);
    expect(current.statements['wdt:P725']?.map((statement) => valueContent(statement.value))).toEqual([correctedVoiceId]);
    expect(current.statements['schema:illustrator']).toBeUndefined();
    expect(await read(personId)).toMatchObject({ id: personId, type: 'schema:Person' });
    expect(await read(correctedVoiceId)).toMatchObject({ id: correctedVoiceId, type: 'schema:Person' });
    expect(await read(characterId)).toMatchObject({ id: characterId, type: 'wd:Q95074' });
    for (const otherWorkKey of ['v2', 'v3']) {
      const otherWorkId = correctedIdentities.get(otherWorkKey)!;
      const otherWork = await read(otherWorkId);
      expect(otherWork.statements['schema:author']).toBeUndefined();
      expect(otherWork.statements['wdt:P725']).toBeUndefined();
    }

    const correctedCreditKeys = creditProposalKeys();
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const reopened = await seedCrossMedia(correctedPlan, statePath, port, destination, {
      mediaDeadlineMs: 0,
      vndbCreditReferences: references,
      readPublicSubject: (id) => publicClient.readSubject(id),
    });
    const reopenedIdentities = new Map(reopened.readings.map((row) => [row.externalId, row.subject.subject.id]));
    expect(reopenedIdentities.get('v1')).toBe(workId);
    expect(reopenedIdentities.get('s4')).toBe(personId);
    expect(reopenedIdentities.get('s5')).toBe(correctedVoiceId);
    expect(reopenedIdentities.get('c3')).toBe(characterId);
    expect(creditProposalKeys()).toEqual(correctedCreditKeys);
    const reopenedWork = await read(workId);
    expectPublicCredit(reopenedWork, author);
    expectPublicCredit(reopenedWork, voice);
    expect(reopenedWork.statements['schema:author']).toHaveLength(1);
    expect(reopenedWork.statements['wdt:P725']).toHaveLength(1);
    expect(reopenedWork.statements['schema:illustrator']).toBeUndefined();
    expect(await currentSchemeIds(designId)).toEqual([wrongSchemeId]);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    journal?.close();
    try {
      await runtime.close(failure);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 180_000);
