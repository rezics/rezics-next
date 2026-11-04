import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { crossMediaBangumiRevision } from '../../../importer/src/source-registry.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const origin = 'https://kernel.import.test';
const globalContext = '00000000-0000-8000-8000-000000000000';
const gameId = 990301;
const gameExternalId = String(gameId);
const website = 'https://games.example/portal?edition=global#home';
const descriptive = 'https://guide.example/game?chapter=2#walkthrough';

function sourceTables(infobox: string): CrossMediaTables {
  // Authored source-shaped example; this is not a live Bangumi observation.
  const rows = [
    { id: gameId, type: 4, name: 'CLANNAD', infobox },
    { id: 990302, type: 2, name: 'CLANNAD' },
  ];
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield* rows;
    },
  };
}

function idOf(reading: { subject: unknown }) {
  const value = reading.subject as { subject?: { id?: string }; id?: string };
  return value.subject?.id ?? value.id;
}

function statementValue(statement: BatchStatement) {
  return statement.value.type === 'value' ? statement.value.content : undefined;
}

function publicValues(reading: unknown, property: string) {
  const value = reading as { subject?: { statements?: Record<string, BatchStatement[]> } };
  return (value.subject?.statements?.[property] ?? []).map(statementValue);
}

test('selected Bangumi Game destinations survive independent review, correction and current reads', async () => {
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpdir();
  const runtime = await (async () => {
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-web-destinations-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const publicClient = createPublicBulkClient({
      origin,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(String(input));
          return runtime.request(`${url.pathname}${url.search}`);
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const state = join(directory, 'import.sqlite');
    async function run(infobox: string) {
      const plan = await planCrossMediaSeed(sourceTables(infobox));
      const result = await seedCrossMedia(
        plan,
        state,
        captureShowcaseCommands(runtime.importTransport, journal),
        { origin },
        { providers: ['bangumi'] },
      );
      return { plan, result };
    }
    async function publish(value: Awaited<ReturnType<typeof run>>) {
      return publishShowcase({
        plan: value.plan,
        result: value.result,
        aliases: crossMediaAliases,
        journal,
        review: runtime.importTransport,
        publicClient,
      });
    }
    async function gameIdFrom(value: Awaited<ReturnType<typeof run>>) {
      const reading = value.result.readings.find((row) => row.externalId === gameExternalId);
      if (!reading) throw new Error('Selected Bangumi Game has no current native reading');
      const id = idOf(reading);
      if (!id) throw new Error('Selected Bangumi Game has no acknowledged UUID');
      return id;
    }
    const infobox = (link: string) =>
      ['{{Infobox Game', `|website=${website}`, `|链接=${link}`, '}}'].join('\n');

    const first = await run(infobox(`${descriptive} with mixed prose`));
    expect(first.plan.records.bangumi.some((record) => record.key === gameExternalId)).toBe(true);
    const subjectId = await gameIdFrom(first);
    const websitePage = await runtime.importTransport.reviewedCandidates(subjectId, {
      property: 'schema:url',
      context: globalContext,
      limit: 100,
    });
    const websiteCandidate = websitePage.candidates.filter((candidate) => 'statement' in candidate).find(
      (candidate) =>
        candidate.source?.external_id === gameExternalId &&
        candidate.statement.property.id === 'schema:url' &&
        statementValue(candidate.statement) === website,
    );
    expect(websiteCandidate?.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: gameExternalId,
      record_revision: 'unversioned',
      converter_revision: crossMediaBangumiRevision,
    });
    const malformedPage = await runtime.importTransport.reviewedCandidates(subjectId, {
      property: 'wdt:P973',
      context: globalContext,
      limit: 100,
    });
    expect(malformedPage.candidates.some((candidate) => 'source' in candidate && candidate.source?.external_id === gameExternalId)).toBe(false);

    await publish(first);
    expect(publicValues(await publicClient.readSubject(subjectId), 'schema:url')).toContain(website);
    expect(publicValues(await publicClient.readSubject(subjectId), 'wdt:P973')).not.toContain(descriptive);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const corrected = await run(infobox(descriptive));
    expect(corrected.result.runs.bangumi?.counts.changed).toBe(1);
    expect(await gameIdFrom(corrected)).toBe(subjectId);
    const descriptivePage = await runtime.importTransport.reviewedCandidates(subjectId, {
      property: 'wdt:P973',
      context: globalContext,
      limit: 100,
    });
    const descriptiveCandidate = descriptivePage.candidates.filter((candidate) => 'statement' in candidate).find(
      (candidate) =>
        candidate.source?.external_id === gameExternalId &&
        candidate.statement.property.id === 'wdt:P973' &&
        statementValue(candidate.statement) === descriptive,
    );
    expect(descriptiveCandidate?.id).toBeTruthy();
    expect(descriptiveCandidate?.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: gameExternalId,
      record_revision: 'unversioned',
      converter_revision: crossMediaBangumiRevision,
    });

    await publish(corrected);
    const websiteAdoption = await runtime.importTransport.reviewedCandidates(subjectId, {
      property: 'schema:url',
      context: globalContext,
      limit: 100,
    });
    const descriptiveAdoption = await runtime.importTransport.reviewedCandidates(subjectId, {
      property: 'wdt:P973',
      context: globalContext,
      limit: 100,
    });
    expect(websiteAdoption.adoption?.mode).toBe('replace');
    expect(websiteAdoption.adoption?.head).toBeGreaterThan(0);
    expect(descriptiveAdoption.adoption?.mode).toBe('replace');
    expect(descriptiveAdoption.adoption?.head).toBeGreaterThan(0);
    const publicGame = await publicClient.readSubject(subjectId);
    expect((publicGame.subject as { type: string }).type).toBe('schema:VideoGame');
    expect(publicValues(publicGame, 'schema:name')).toContainEqual({ language: 'und', text: 'CLANNAD' });
    expect(publicValues(publicGame, 'schema:url')).toContain(website);
    expect(publicValues(publicGame, 'wdt:P973')).toContain(descriptive);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
