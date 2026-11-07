import { expect, test } from 'bun:test';
import { citedAnimeCreditTargets, journeyTargets, selectJourneyWorks } from '../src/showcase-bangumi-journey.ts';
import {
  FIRST_PUBLIC_IMPORT_ROWS,
  applyWalkInventoryToCapabilities,
  capabilitiesResultCell,
  firstPublicRow,
  licensedVndbArchive,
  selectPublished,
  walkInventorySummary,
  walkRepairBrief,
  walkRepairSkipReason,
  type WalkInventory,
  type WalkRowResult,
} from '../src/imports-public-journey.ts';
import {
  BOOK_OWNER_GRANT_ACTIONS,
  admitOrdinaryOwnerGrantStatus,
  grantOrdinaryOwnerActions,
  ordinaryOwnerGrantBody,
  ordinaryOwnerGrantKey,
  ordinaryOwnerGrantResource,
} from '../src/ordinary-owner-grants.ts';

function publishedRow(sourceKey: string, provider = 'bangumi') {
  return {
    provider,
    sourceKey,
    subjectId: `subject-${provider}-${sourceKey}`,
    nativeType: 'schema:Book',
    readerRoute: `/subjects/subject-${provider}-${sourceKey}`,
    assertions: [{ citations: [`https://bgm.tv/subject/${sourceKey}`] }],
  };
}

test('the journey visits the selected anime and both light-novel families once each', () => {
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  const works = selectJourneyWorks([...published, publishedRow('999', 'vndb')]);
  expect(works.map((work) => work.sourceKey)).toEqual(journeyTargets.map((target) => target.sourceKey));
  expect(works.find((work) => work.sourceKey === '233')).toMatchObject({ role: 'anime' });
  expect(works.find((work) => work.sourceKey === '5329')).toMatchObject({ role: 'volume', series: '2815' });
  expect(works.find((work) => work.sourceKey === '10862')).toMatchObject({ role: 'volume', series: '2815' });
});

test('a missing or duplicated target stops the journey by its exact source key', () => {
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  expect(() => selectJourneyWorks(published.filter((row) => row.sourceKey !== '233'))).toThrow(
    'journey target bangumi:233 has 0 rows',
  );
  expect(() => selectJourneyWorks([...published, publishedRow('2815')])).toThrow(
    'journey target bangumi:2815 has 2 rows',
  );
});

test('anime Work targets require the selected Bangumi credit row and preserve its exact citation', () => {
  const statement = (id: string, property: string, target: string, citation: string) => ({
    id,
    property: { id: property },
    value: { type: 'value', content: target },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: citation },
          },
        ],
      },
    ],
  });
  const read = {
    subject: {
      id: 'anime-233',
      type: 'schema:TVSeries',
      statements: {
        'wdt:P725': [
          statement('voice-1', 'wdt:P725', 'person-1', 'https://bgm.tv/subject/233#/person-characters/233/16/304'),
          statement(
            'voice-unrelated',
            'wdt:P725',
            'person-unrelated',
            'https://bgm.tv/subject/2815#/person-characters/2815/16/304',
          ),
        ],
        'schema:director': [
          statement(
            'director-1',
            'schema:director',
            'person-2',
            'https://bgm.tv/subject/233#/subject-persons/233/42/position',
          ),
          statement('director-uncited', 'schema:director', 'person-3', 'https://bgm.tv/subject/233'),
        ],
      },
    },
  };

  expect(citedAnimeCreditTargets(read, '233', 'cast')).toEqual([
    expect.objectContaining({
      id: 'person-1',
      property: 'wdt:P725',
      citation: 'https://bgm.tv/subject/233#/person-characters/233/16/304',
      statementId: 'voice-1',
      holder: 'anime-233',
      kind: 'person',
    }),
  ]);
  expect(citedAnimeCreditTargets(read, '233', 'staff')).toEqual([
    expect.objectContaining({
      id: 'person-2',
      property: 'schema:director',
      citation: 'https://bgm.tv/subject/233#/subject-persons/233/42/position',
      statementId: 'director-1',
      holder: 'anime-233',
      kind: 'person',
    }),
  ]);
});

test('the first-public walk names twelve operator and catalogue rows once each', () => {
  expect(FIRST_PUBLIC_IMPORT_ROWS.map((row) => row.id)).toEqual([
    'I01',
    'I02',
    'I03',
    'I04',
    'I05',
    'I06',
    'I07',
    'I08',
    'I09',
    'I10',
    'I11',
    'I12',
  ]);
  expect(firstPublicRow('I03').path).toContain('Open Library');
  expect(firstPublicRow('I11').path).toContain('499');
  const published = journeyTargets.map((target) => publishedRow(target.sourceKey));
  expect(selectPublished(published, 'bangumi', '2815').sourceKey).toBe('2815');
  expect(() => selectPublished(published, 'bangumi', 'missing')).toThrow('published bangumi:missing has 0 rows');
});

test('ordinary owner grants use one action, a stable receipt key, and admit replay', () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const resource = ordinaryOwnerGrantResource();
  expect(BOOK_OWNER_GRANT_ACTIONS).toEqual(['statement:propose', 'context:accept', 'context:adopt']);
  expect(ordinaryOwnerGrantBody(account, 'context:adopt')).toEqual({
    resource,
    subject: { kind: 'account', id: account },
    actions: ['context:adopt'],
    valid: '(,)',
  });
  expect(ordinaryOwnerGrantKey(resource, account, 'context:adopt')).toBe(
    `accounts.grant:0:${resource.id}:${account}:context:adopt`,
  );
  expect(admitOrdinaryOwnerGrantStatus(201)).toBe(true);
  expect(admitOrdinaryOwnerGrantStatus(409)).toBe(true);
  expect(admitOrdinaryOwnerGrantStatus(403)).toBe(false);
});

test('ordinary owner grants post one action at a time and treat 409 as replay', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const posted: { action: string; key: string }[] = [];
  await grantOrdinaryOwnerActions({
    accountId: account,
    actions: BOOK_OWNER_GRANT_ACTIONS,
    post: async ({ body, idempotencyKey }) => {
      posted.push({ action: body.actions[0]!, key: idempotencyKey });
      return { status: posted.length === 1 ? 201 : 409, text: '' };
    },
  });
  expect(posted.map((row) => row.action)).toEqual([...BOOK_OWNER_GRANT_ACTIONS]);
  expect(posted[1]!.key).toContain('context:accept');
  await expect(
    grantOrdinaryOwnerActions({
      accountId: account,
      actions: ['context:adopt'],
      post: async () => ({ status: 403, text: 'forbidden' }),
    }),
  ).rejects.toThrow('Grant context:adopt');
});

test('the licensed VNDB walk archive starts with TIMESTAMP then db/vn.header', async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of licensedVndbArchive()) chunks.push(chunk);
  expect(new TextDecoder().decode(chunks[0]!.subarray(0, 9))).toBe('TIMESTAMP');
  expect(new TextDecoder().decode(chunks[1]!.subarray(0, 12))).toBe('db/vn.header');
  expect(chunks.at(-1)?.byteLength).toBe(1024);
});

test('the walk inventory reports passing over twelve and the slowest failing journey', () => {
  const inventory: WalkInventory = {
    command: 'bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts',
    revision: 'abc',
    startedAt: '2026-11-07T00:00:00Z',
    endedAt: '2026-11-07T00:10:00Z',
    passing: 10,
    total: 12,
    slowestFailing: {
      id: 'I06',
      path: 'Game/Release/counterpart',
      elapsedMs: 12_000,
      cause: 'seed published no Game identity',
    },
    rows: FIRST_PUBLIC_IMPORT_ROWS.map((row) => ({
      id: row.id,
      path: row.path,
      result: row.id === 'I06' || row.id === 'I09' ? 'failing' : 'passing',
      elapsedMs: row.id === 'I06' ? 12_000 : 100,
      cause: row.id === 'I06' ? 'seed published no Game identity' : row.id === 'I09' ? 'no tag' : null,
      evidence: {},
    })),
  };
  expect(walkInventorySummary(inventory)).toBe(
    '10/12 passing; slowest failing I06 12000ms seed published no Game identity; 2 failing',
  );
});

test('the walk inventory replaces each pending capabilities row and names the slowest failure', () => {
  const failing: WalkRowResult = {
    id: 'I06',
    path: 'Game/Release/counterpart',
    result: 'failing',
    elapsedMs: 12_000,
    cause: 'seed published no Game identity',
    evidence: { seed: true },
  };
  const passing: WalkRowResult = {
    id: 'I01',
    path: 'Bangumi operator',
    result: 'passing',
    elapsedMs: 40,
    cause: null,
    evidence: { id: 'subject-1', type: 'schema:Thing' },
  };
  expect(capabilitiesResultCell(passing)).toContain('passing; 40ms; id subject-1');
  const markdown = `| Path | Scope | Current dev result and evidence |\n| ---- | ----- | ------------------------------- |\n| I01  | Bangumi operator | Pending initial dev walk.       |\n| I06  | Game | Pending initial dev walk.       |\n\nBooks owner-grant composition uses the ordinary Global grant intent.\n`;
  const updated = applyWalkInventoryToCapabilities(markdown, {
    command: 'bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts',
    revision: 'abc',
    startedAt: '2026-11-07T00:00:00Z',
    endedAt: '2026-11-07T00:10:00Z',
    passing: 1,
    total: 2,
    slowestFailing: { id: 'I06', path: failing.path, elapsedMs: 12_000, cause: failing.cause! },
    rows: [passing, failing],
  });
  expect(updated).toContain('passing; 40ms; id subject-1, type schema:Thing');
  expect(updated).toContain('failing; 12000ms; seed published no Game identity');
  expect(updated).toContain('### Observed walk');
  expect(updated).toContain('Slowest failing: I06 12000ms seed published no Game identity.');
  expect(updated).toContain('Books owner-grant composition uses the ordinary Global grant intent.');
  expect(walkRepairSkipReason(failing)).toBeNull();
  expect(walkRepairBrief(
    {
      command: 'walk',
      revision: 'abc',
      startedAt: 't0',
      endedAt: 't1',
      passing: 1,
      total: 2,
      slowestFailing: { id: 'I06', path: failing.path, elapsedMs: 12_000, cause: failing.cause! },
      rows: [passing, failing],
    },
    failing,
  )).toContain('Goal: imports');
  expect(
    walkRepairSkipReason({
      ...failing,
      id: 'I09',
      cause: 'same-handle continuation lost the independent property',
    }),
  ).toContain('same-handle continuation');
});
