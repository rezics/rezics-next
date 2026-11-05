import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { Pool } from 'pg';
import { newId } from '../../src/route/route.ts';
import { shelfCursorBinding } from '../../src/library/shelf-contract.ts';
import {
  createShelfTitleReader,
  shelfTitleBinding,
  validShelfTitleSeek,
} from '../../src/library/shelf-title-reader.ts';
import { shelfTitleObservations } from '../../src/library/shelf-title-maintenance.ts';
import { currentShelfTitleBasis, shelfTitlePolicy } from '../../src/library/shelf-title-source.ts';
import { ShelfReadUnavailableError } from '../../src/library/shelf-reader-unavailable.ts';

const route = 0x6a10,
  accountId = newId(route),
  subjectId = newId(0x7b20);
const actor = {
  kind: 'account' as const,
  accountId,
  clientId: newId(route),
  requestedBy: null,
  authnEpoch: 1,
  scopes: ['library_entry:list', 'progress_session:list'],
};
const owner = { route, accountId };
afterEach(() => mock.restore());

test('title policy and cursor query distinguish language precedence, state, Type and direction', () => {
  expect(shelfTitlePolicy(['fr-CA', 'en'])).toBe(shelfTitlePolicy(['FR-ca', 'EN']));
  expect(shelfTitlePolicy(['fr', 'en'])).not.toBe(shelfTitlePolicy(['en', 'fr']));
  const query = { orderBy: 'title' as const, direction: 'asc' as const, state: 'planned', typeId: newId(route) };
  const first = shelfCursorBinding(accountId, query);
  for (const changed of [
    { state: 'completed' },
    { typeId: null },
    { direction: 'desc' as const },
    { orderBy: 'createdAt' as const },
  ])
    expect(shelfCursorBinding(accountId, { ...query, ...changed })).not.toEqual(first);
  expect(shelfCursorBinding(newId(route), query)).not.toEqual(first);
});

test('denied/hidden/partial title observations stay unavailable; visible missing labels are explicit', async () => {
  const missingProducer = currentShelfTitleBasis(undefined, owner, ['en'], actor);
  await expect(missingProducer).rejects.toBeInstanceOf(ShelfReadUnavailableError);
  await expect(missingProducer).rejects.toMatchObject({
    binding: 'Content shelfTitleInputs.observe complete-source producer installation',
  });
  const incompleteSource = currentShelfTitleBasis(
    { basis: async () => ({ status: 'unavailable' }), labels: async () => ({ status: 'unavailable' }) },
    owner,
    ['en'],
    actor,
  );
  await expect(incompleteSource).rejects.toBeInstanceOf(ShelfReadUnavailableError);
  await expect(incompleteSource).rejects.toMatchObject({
    binding: 'Content complete whole-source title/disclosure/redirect/identity/source-owner observation',
  });
  expect(() => shelfTitleObservations([subjectId], [])).toThrow(ShelfReadUnavailableError);
  const observation = { subjectId, sourceId: subjectId, sourceBasis: 'owner:revision:1', labels: {} };
  expect(shelfTitleObservations([subjectId], [observation]).get(subjectId)?.labels).toEqual({});
  expect(() => shelfTitleObservations([subjectId], [observation, observation])).toThrow(ShelfReadUnavailableError);
  expect(() =>
    shelfTitleObservations([subjectId, subjectId], [observation, { ...observation, subjectId: newId(0x7b20) }]),
  ).toThrow(ShelfReadUnavailableError);
  const oversized = Array.from({ length: 101 }, () => ({ ...observation, subjectId: newId(0x7b20) }));
  expect(() =>
    shelfTitleObservations(
      oversized.map((row) => row.subjectId),
      oversized,
    ),
  ).toThrow(ShelfReadUnavailableError);
});

test('an uninstalled or currentness-mismatched native generation cannot supply a title cursor', async () => {
  const client = new Pool();
  spyOn(client, 'query').mockImplementation(async () => ({
    rows: [],
    command: 'SELECT',
    rowCount: 0,
    oid: 0,
    fields: [],
  }));
  await expect(shelfTitleBinding(client, route, accountId, ['en'], 'new-source-basis')).rejects.toBeInstanceOf(
    ShelfReadUnavailableError,
  );
  expect(validShelfTitleSeek('m:')).toBe(true);
  expect(validShelfTitleSeek('l:')).toBe(true);
  expect(validShelfTitleSeek(`l:${Buffer.from('road').toString('base64url')}`)).toBe(true);
  for (const key of ['road', 'l:cg==', 'm:title', `l:${'a'.repeat(1400)}`])
    expect(validShelfTitleSeek(key)).toBe(false);
});

test('native title rows retain returned order, missing coverage and the exact private seek boundary', async () => {
  const client = new Pool();
  const row = {
    subjectId,
    incarnationId: newId(route),
    state: 'planned',
    revision: 1,
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
    lastActivityAt: '2026-11-04T00:00:00Z',
    finishedAt: null,
    current: true,
    key: Buffer.from('road'),
    missing: false,
  };
  const query = spyOn(client, 'query').mockImplementation(async () => ({
    rows: [row, { ...row, subjectId: newId(0x7b20), missing: true, key: Buffer.alloc(0) }],
    command: 'SELECT',
    rowCount: 2,
    oid: 0,
    fields: [],
  }));
  const page = await createShelfTitleReader().page(
    client,
    route,
    accountId,
    {
      orderBy: 'title',
      direction: 'desc',
      limit: 2,
      state: null,
      typeId: null,
      titleGeneration: newId(route),
    },
    null,
  );
  expect(page.entries.map((entry) => entry.titleCoverage)).toEqual(['labelled', 'missing']);
  expect(page.entries.map((entry) => entry.subjectId)).toEqual([row.subjectId, page.after!.subjectId]);
  expect(page.after?.key).toBe('m:');
  expect(page.entries[0]).not.toHaveProperty('key');
  expect(page.entries[0]).not.toHaveProperty('current');
  query.mockImplementation(async () => ({
    rows: [{ ...row, current: false }],
    command: 'SELECT',
    rowCount: 1,
    oid: 0,
    fields: [],
  }));
  await expect(
    createShelfTitleReader().page(
      client,
      route,
      accountId,
      {
        orderBy: 'title',
        direction: 'asc',
        limit: 2,
        state: null,
        typeId: null,
        titleGeneration: newId(route),
      },
      null,
    ),
  ).rejects.toBeInstanceOf(ShelfReadUnavailableError);
});
