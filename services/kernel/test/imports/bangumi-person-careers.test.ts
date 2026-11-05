import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaPlan,
  type CrossMediaPort,
} from '../../../importer/src/cross-media-seed.ts';
import {
  bangumiPersonCareerAdmission,
  acquireBangumiPersonCareerSources,
} from '../../../importer/src/showcase-bangumi-careers.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import {
  prepareShowcaseBangumiSelectedCharacterVocabulary,
  readShowcaseBangumiSelectedCharacterVocabulary,
} from '../../../importer/src/showcase-bangumi-game-characters.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

type ReadStatement = {
  value: { content: unknown };
  references?: { parts: { property: { id: string }; value: { type: string; content: unknown } }[] }[];
};

function planFor(name: string, revision: string): CrossMediaPlan {
  const plan = emptyCrossMediaPlan();
  plan.entities.bangumi.push({
    source: 'bangumi',
    key: 'person:8101',
    revision,
    payload: { id: 8101, type: 1, name, summary: 'Biography remains independently sourced.' },
  });
  plan.members.push({ source: 'bangumi', key: 'person:8101', kind: 'person', membership: 'referenced' });
  return plan;
}

function bindingsFor(...codes: string[]): SourceVocabularyBindings {
  const schemeId = '00000000-0000-4000-8000-000000000101';
  return {
    releaseDigest: bundledDigest,
    schemes: [
      {
        taxonomy: 'bangumi.person.career',
        id: schemeId,
        uri: 'https://rezics.com/schemes/bangumi/careers',
        type: 'skos:ConceptScheme',
        releaseDigest: bundledDigest,
      },
    ],
    concepts: codes.map((code, index) => ({
      taxonomy: 'bangumi.person.career',
      code,
      id: `00000000-0000-4000-8000-${String(201 + index).padStart(12, '0')}`,
      type: 'skos:Concept' as const,
      schemeId,
      releaseDigest: bundledDigest,
    })),
  };
}

function idOf(result: { readings: { externalId: string; subject: unknown }[] }, externalId: string): string {
  const reading = result.readings.find((row) => row.externalId === externalId);
  const id = (reading?.subject as { subject?: { id?: unknown } } | undefined)?.subject?.id;
  if (typeof id !== 'string') throw new Error(`Missing acknowledged identity for ${externalId}`);
  return id;
}

function statements(read: Awaited<ReturnType<ReturnType<typeof createPublicBulkClient>['readSubject']>>) {
  return (read.subject as { statements: Record<string, ReadStatement[]> }).statements;
}

function capturedCommands(runtime: Awaited<ReturnType<typeof openApiRuntime>>, from = 0): BatchCommand[] {
  return runtime.captures.slice(from).flatMap((capture) => {
    if (!new URL(capture.request.url).pathname.endsWith('/subjects:batchWrite')) return [];
    return (JSON.parse(capture.body) as { commands: BatchCommand[] }).commands;
  });
}

function capturedWriteBodies(
  runtime: Awaited<ReturnType<typeof openApiRuntime>>,
  property: string,
  from = 0,
): string[] {
  return runtime.captures.slice(from).flatMap((capture) => {
    if (!new URL(capture.request.url).pathname.endsWith('/subjects:batchWrite')) return [];
    const commands = (JSON.parse(capture.body) as { commands: BatchCommand[] }).commands;
    return commands.some((command) => command.op === 'propose' && command.statement.property.id === property)
      ? [capture.body]
      : [];
  });
}

test('Bangumi Person careers use default current vocabulary, ordinary proposals and independent current reads', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-person-careers-native-'));
  const importPath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: (async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      }) as typeof fetch,
    });
    let port = captureShowcaseCommands(runtime.importTransport, journal);
    const personBytes = JSON.stringify({
      id: 8101,
      type: 1,
      career: ['producer'],
      infobox: [{ key: '简体中文名', value: '星見中文' }],
    });
    let plan = await acquireBangumiPersonCareerSources(planFor('星見', 'archive-v1'), {
      journal,
      fetch: (async (input) => {
        expect(String(input)).toBe('https://api.bgm.tv/v0/persons/8101');
        return new Response(personBytes, { headers: { etag: '"person-8101-v1"' } });
      }) as typeof fetch,
      sleep: async () => {},
    });
    expect(plan.personCareerSources?.[0]?.responseDigest).toBe(createHash('sha256').update(personBytes).digest('hex'));
    expect(plan.personCareerSources?.[0]?.personChineseName).toBe('星見中文');
    expect(plan.entities.bangumi.find(({ key }) => key === 'person:8101')?.payload).toMatchObject({
      name_cn: '星見中文',
      career: ['producer'],
    });

    const emptyBindings: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
    const initialAdmission = bangumiPersonCareerAdmission(
      crossMediaAliases.bangumi,
      emptyBindings,
      plan.personCareerSources,
    );
    const initialCaptureStart = runtime.captures.length;
    let loseNameReply = true;
    const uncertainNameTransport: CrossMediaPort = {
      ...runtime.importTransport,
      async batch(request) {
        const response = await runtime.importTransport.batch(request);
        if (
          loseNameReply &&
          request.commands.some(
            (command) => command.op === 'propose' && command.statement.property.id === 'schema:name',
          )
        ) {
          loseNameReply = false;
          throw new Error('name proposal response lost after send');
        }
        return response;
      },
    };
    await expect(
      seedCrossMedia(
        plan,
        importPath,
        captureShowcaseCommands(uncertainNameTransport, journal),
        { origin: runtime.origin },
        { providers: ['bangumi'], vocabularyAdmissions: [initialAdmission] },
      ),
    ).rejects.toThrow('Cross-media bangumi import failed');
    const firstNameCommands = capturedCommands(runtime, initialCaptureStart).filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:name',
    );
    expect(firstNameCommands).toHaveLength(2);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const initial = await seedCrossMedia(
      plan,
      importPath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'], vocabularyAdmissions: [initialAdmission] },
    );
    const nameCommands = capturedCommands(runtime, initialCaptureStart).filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:name',
    );
    expect(nameCommands).toHaveLength(4);
    expect(nameCommands.slice(0, 2)).toEqual(nameCommands.slice(2, 4));
    const nameBodies = capturedWriteBodies(runtime, 'schema:name', initialCaptureStart);
    expect(nameBodies).toHaveLength(2);
    expect(nameBodies[0]).toBe(nameBodies[1]);
    const personId = idOf(initial, 'person:8101');
    expect(initial.runs.bangumi?.status).toBe('committed');
    expect(
      capturedCommands(runtime).some(
        (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P106',
      ),
    ).toBe(false);
    const proposedNames = (
      await runtime.importTransport.reviewedCandidates(personId, {
        property: 'schema:name',
        context: GLOBAL_CONTEXT,
        limit: 100,
      })
    ).candidates.map(({ statement }) => statement.value.content);
    expect(proposedNames).toEqual([
      { language: 'und', text: '星見' },
      { language: 'zh', text: '星見中文' },
    ]);
    expect(
      statements(await publicClient.readSubject(personId))['schema:name']?.map(({ value }) => value.content) ?? [],
    ).not.toContainEqual({ language: 'zh', text: '星見中文' });

    const schemes = await prepareShowcaseBangumiSelectedCharacterVocabulary({ plan, port, journal, stage: 'schemes' });
    expect(schemes.requirements.map(({ sourceUri }) => sourceUri)).toContain(
      'https://rezics.com/schemes/bangumi/careers',
    );
    await publishShowcase({
      plan,
      result: initial,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: schemes.requirements,
    });
    const concepts = await prepareShowcaseBangumiSelectedCharacterVocabulary({
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    expect(concepts.requirements.map(({ sourceKey }) => sourceKey)).toContain('bangumi.person.career:producer');
    await publishShowcase({
      plan,
      result: initial,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });
    const selectedPersonNames = statements(await publicClient.readSubject(personId))['schema:name']?.map(
      ({ value }) => value.content,
    );
    expect(selectedPersonNames).toEqual(
      expect.arrayContaining([
        { language: 'und', text: '星見' },
        { language: 'zh', text: '星見中文' },
      ]),
    );
    const current = await readShowcaseBangumiSelectedCharacterVocabulary({ plan, port, journal });
    const producer = current.concepts.find(
      ({ taxonomy, code }) => taxonomy === 'bangumi.person.career' && code === 'producer',
    );
    expect(producer).toBeDefined();
    expect(
      statements(await publicClient.readSubject(personId))['schema:name']?.map(({ value }) => value.content) ?? [],
    ).toEqual(
      expect.arrayContaining([
        { language: 'und', text: '星見' },
        { language: 'zh', text: '星見中文' },
      ]),
    );
    const producerRead = await port.readReviewedSubject(producer!.id);
    expect((producerRead as { subject: { labels: Record<string, string> } }).subject.labels).toEqual({
      und: 'producer',
    });

    const careerAdmission = bangumiPersonCareerAdmission(crossMediaAliases.bangumi, current, plan.personCareerSources);
    const careerCaptureStart = runtime.captures.length;
    let failAfterSend = true;
    const uncertainCareerTransport: CrossMediaPort = {
      ...runtime.importTransport,
      async batch(request) {
        const response = await runtime.importTransport.batch(request);
        if (
          failAfterSend &&
          request.commands.some((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P106')
        ) {
          failAfterSend = false;
          throw new Error('unknown transport outcome after send');
        }
        return response;
      },
    };
    const uncertainPort = captureShowcaseCommands(uncertainCareerTransport, journal);
    await expect(
      seedCrossMedia(
        plan,
        importPath,
        uncertainPort,
        { origin: runtime.origin },
        { providers: ['bangumi'], vocabularyAdmissions: [careerAdmission] },
      ),
    ).rejects.toThrow('Cross-media bangumi import failed');
    const firstCareerCommand = capturedCommands(runtime, careerCaptureStart).find(
      (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P106',
    );
    expect(firstCareerCommand?.op).toBe('propose');

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    port = captureShowcaseCommands(runtime.importTransport, journal);

    const imported = await seedCrossMedia(
      plan,
      importPath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'], vocabularyAdmissions: [careerAdmission] },
    );
    expect(imported.runs.bangumi?.status).toBe('committed');
    expect(idOf(imported, 'person:8101')).toBe(personId);
    const replayedCareerCommands = capturedCommands(runtime, careerCaptureStart).filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P106',
    );
    expect(replayedCareerCommands.length).toBeGreaterThanOrEqual(2);
    expect(replayedCareerCommands[0]).toEqual(replayedCareerCommands[1]);
    const careerBodies = capturedWriteBodies(runtime, 'wdt:P106', careerCaptureStart);
    expect(careerBodies).toHaveLength(2);
    expect(careerBodies[0]).toBe(careerBodies[1]);
    expect(replayedCareerCommands[0]?.op === 'propose' ? replayedCareerCommands[0].statement.value.content : null).toBe(
      producer?.id,
    );
    await publishShowcase({
      plan,
      result: imported,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });

    const stableCandidates = (
      await runtime.importTransport.reviewedCandidates(personId, {
        property: 'wdt:P106',
        context: GLOBAL_CONTEXT,
        limit: 100,
      })
    ).candidates;
    const restarted = await seedCrossMedia(
      plan,
      importPath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'], vocabularyAdmissions: [careerAdmission] },
    );
    expect(idOf(restarted, 'person:8101')).toBe(personId);
    expect(
      (
        await runtime.importTransport.reviewedCandidates(personId, {
          property: 'wdt:P106',
          context: GLOBAL_CONTEXT,
          limit: 100,
        })
      ).candidates.map(({ id }) => id),
    ).toEqual(stableCandidates.map(({ id }) => id));

    const changedBytes = JSON.stringify({ id: 8101, type: 1, career: ['actor'] });
    const changedPlan = await acquireBangumiPersonCareerSources(planFor('星見 改訂', 'archive-v2'), {
      journal,
      fetch: (async () => new Response(changedBytes, { headers: { etag: '"person-8101-v2"' } })) as typeof fetch,
      sleep: async () => {},
    });
    const withheldAdmission = bangumiPersonCareerAdmission(
      crossMediaAliases.bangumi,
      current,
      changedPlan.personCareerSources,
    );
    const withheldCaptureStart = runtime.captures.length;
    const withheld = await seedCrossMedia(
      changedPlan,
      importPath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'], vocabularyAdmissions: [withheldAdmission] },
    );
    expect(idOf(withheld, 'person:8101')).toBe(personId);
    const currentBeforeRefreshReview = statements(await publicClient.readSubject(personId));
    expect(currentBeforeRefreshReview['schema:name']?.map(({ value }) => value.content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: '星見' },
        { language: 'zh', text: '星見中文' },
      ]),
    );
    expect(
      capturedCommands(runtime, withheldCaptureStart).some(
        (command) => command.op === 'propose' && command.statement.property.id === 'wdt:P106',
      ),
    ).toBe(false);
    const changedNameCandidates = capturedCommands(runtime, withheldCaptureStart).filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:name',
    );
    expect(changedNameCandidates.map(({ statement }) => statement.value.content)).toContainEqual({
      language: 'und',
      text: '星見 改訂',
    });
    expect(changedNameCandidates.map(({ statement }) => statement.value.content)).not.toContainEqual({
      language: 'zh',
      text: '星見中文',
    });

    const actorConcepts = await prepareShowcaseBangumiSelectedCharacterVocabulary({
      plan: changedPlan,
      port,
      journal,
      stage: 'concepts',
    });
    await publishShowcase({
      plan: changedPlan,
      result: withheld,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: actorConcepts.requirements,
    });
    const actorBindings = await readShowcaseBangumiSelectedCharacterVocabulary({ plan: changedPlan, port, journal });
    const actor = actorBindings.concepts.find(
      ({ taxonomy, code }) => taxonomy === 'bangumi.person.career' && code === 'actor',
    );
    expect(actor).toBeDefined();
    const refreshed = await seedCrossMedia(
      changedPlan,
      importPath,
      port,
      { origin: runtime.origin },
      {
        providers: ['bangumi'],
        vocabularyAdmissions: [
          bangumiPersonCareerAdmission(crossMediaAliases.bangumi, actorBindings, changedPlan.personCareerSources),
        ],
      },
    );
    expect(idOf(refreshed, 'person:8101')).toBe(personId);
    await publishShowcase({
      plan: changedPlan,
      result: refreshed,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: actorConcepts.requirements,
    });

    const publicRead = statements(await publicClient.readSubject(personId));
    expect(publicRead['wdt:P6298']?.[0]?.value.content).toBe('8101');
    expect(publicRead['schema:abstract']).toHaveLength(1);
    expect(publicRead['wdt:P106']?.map(({ value }) => value.content)).toContain(actor?.id);
    const occupation = (
      await runtime.importTransport.reviewedCandidates(personId, {
        property: 'wdt:P106',
        context: GLOBAL_CONTEXT,
        limit: 100,
      })
    ).candidates.find(
      (candidate) => candidate.statement.value.type === 'value' && candidate.statement.value.content === actor?.id,
    );
    expect(occupation?.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: 'person:8101',
      converter_revision: expect.stringMatching(/^cross-media-entities@\d+\+bangumi@\d+$/u),
    });
    expect(
      occupation?.statement.references?.some((reference) =>
        reference.parts.some(
          (part) => part.value.type === 'value' && part.value.content === 'https://api.bgm.tv/v0/persons/8101#/career',
        ),
      ),
    ).toBe(true);
    expect(createHash('sha256').update(changedBytes).digest('hex')).toBe(
      changedPlan.personCareerSources?.[0]?.responseDigest,
    );

    await editor.takedown(crossMediaAliases.bangumi, 'person:8101', 'facts');
    const fencedBytes = JSON.stringify({ id: 8101, type: 1, career: ['actor'] });
    const fencedPlan = await acquireBangumiPersonCareerSources(planFor('星見 fencing', 'archive-v3'), {
      journal,
      fetch: (async () => new Response(fencedBytes, { headers: { etag: '"person-8101-v3"' } })) as typeof fetch,
      sleep: async () => {},
    });
    const fenceCaptureStart = runtime.captures.length;
    const fenced = await seedCrossMedia(
      fencedPlan,
      importPath,
      port,
      { origin: runtime.origin },
      {
        providers: ['bangumi'],
        vocabularyAdmissions: [
          bangumiPersonCareerAdmission(crossMediaAliases.bangumi, actorBindings, fencedPlan.personCareerSources),
        ],
      },
    );
    expect(fenced.runs.bangumi?.status).toBe('committed');
    expect(idOf(fenced, 'person:8101')).toBe(personId);
    expect(
      capturedCommands(runtime, fenceCaptureStart).some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'person:8101' &&
          command.statement.property.id === 'wdt:P106',
      ),
    ).toBe(false);
    expect(statements(await publicClient.readSubject(personId))['schema:abstract']).toHaveLength(1);

    journal.close();
  } finally {
    try {
      journal.close();
    } catch {}
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);
