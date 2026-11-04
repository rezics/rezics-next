import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { converter_revision as entityRevision } from '../../../../packages/conversion/src/cross-media-entities.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const gameId = 94002;
const recordUrl = `https://bgm.tv/subject/${gameId}`;
const expectedDate = { time: '+2006-04-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' };

function selectedPlan(releaseDate: string) {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({
    source: 'bangumi',
    key: String(gameId),
    revision: null,
    payload: {
      id: gameId,
      type: 4,
      name: 'Clockwork Orchard',
      date: '1999-12-31',
      infobox: `{{Infobox Game\n|发行日期=${releaseDate}\n}}`,
    },
  });
  plan.members.push({
    source: 'bangumi',
    key: String(gameId),
    kind: 'work',
    membership: 'family',
    franchise: 'steins-gate',
  });
  return plan;
}

test('selected Bangumi Game date is independently adopted, read at source precision, refreshed on the same UUID and fenced', async () => {
  expect(converter_revision).toBe('bangumi@9');
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-publication-native-'));
  const importPath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    const editor = await openApiObserver(runtime);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    const importSelected = async (releaseDate: string) => {
      const plan = selectedPlan(releaseDate);
      const result = await seedCrossMedia(
        plan,
        importPath,
        captureShowcaseCommands(runtime.importTransport, journal),
        { origin: runtime.origin },
        { providers: ['bangumi'] },
      );
      const id = result.readings.find((reading) => reading.externalId === String(gameId))?.subject.subject?.id;
      if (!id) throw new Error('Selected Bangumi Game has no acknowledged native identity');
      return { plan, result, id };
    };
    const candidatePage = (id: string) =>
      runtime.importTransport.reviewedCandidates(id, {
        property: 'schema:datePublished',
        context: GLOBAL_CONTEXT,
        limit: 100,
      });
    const malformed = await importSelected('Japanese edition 2006-04-15');
    expect((await candidatePage(malformed.id)).candidates).toEqual([]);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const corrected = await importSelected('2006-04');
    expect(corrected.id).toBe(malformed.id);
    const candidates = (await candidatePage(corrected.id)).candidates;
    const dateCandidate = candidates.find((candidate) => candidate.source?.external_id === String(gameId));
    if (!dateCandidate) throw new Error('Corrected Game date candidate was not acknowledged');
    expect(dateCandidate.statement.value.content).toEqual(expectedDate);
    expect(dateCandidate.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: String(gameId),
      record_revision: 'unversioned',
      converter_revision: `${converter_revision}+${entityRevision}`,
    });
    expect(
      dateCandidate.statement.references?.some((reference) =>
        reference.parts.some((part) => part.property.id === 'schema:url' && part.value.content === recordUrl),
      ),
    ).toBe(true);
    expect(
      (await publicClient.readSubject(corrected.id).then((read) => read.subject as { statements: Record<string, unknown[]> }))
        .statements['schema:datePublished'],
    ).toBeUndefined();

    expect(
      (
        await publishShowcase({
          plan: corrected.plan,
          result: corrected.result,
          aliases: crossMediaAliases,
          journal,
          review: runtime.importTransport,
          publicClient,
        })
      ).status,
    ).toBe('incomplete');
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    expect(
      (
        await publishShowcase({
          plan: corrected.plan,
          result: corrected.result,
          aliases: crossMediaAliases,
          journal,
          review: runtime.importTransport,
          publicClient,
        })
      ).status,
    ).toBe('published');
    const adopted = await candidatePage(corrected.id);
    expect(adopted.adoption?.selection?.map((selection) => selection.candidate)).toContain(dateCandidate.id);
    const current = await publicClient.readSubject(corrected.id);
    const currentDates = (current.subject as { statements: Record<string, { value: { content: unknown }; references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[]> }).statements[
      'schema:datePublished'
    ];
    expect(currentDates?.[0]?.value.content).toEqual(expectedDate);
    expect(
      currentDates?.[0]?.references?.some((reference) =>
        reference.parts.some((part) => part.property.id === 'schema:url' && part.value.content === recordUrl),
      ),
    ).toBe(true);

    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId: String(gameId),
      fieldGroup: 'facts',
      reason: 'Current Game facts fence',
    });
    expect(fence.status).toBe(200);
    const fenced = await importSelected('2006-05');
    expect(fenced.id).toBe(corrected.id);
    const afterFence = (await candidatePage(fenced.id)).candidates;
    expect(afterFence.some((candidate) => JSON.stringify(candidate.statement.value.content).includes('+2006-05'))).toBe(
      false,
    );
    const after = await publicClient.readSubject(fenced.id);
    expect(
      (after.subject as { statements: Record<string, { value: { content: unknown } }[]> }).statements[
        'schema:datePublished'
      ]?.[0]?.value.content,
    ).toEqual(expectedDate);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);
