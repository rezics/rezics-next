import { expect, test } from 'bun:test';
import {
  DISCOVERY_EFFECTS,
  discoveryEventEffect,
} from '../../../services/main/src/modules/discovery/effects.ts';
import { discoverOutboxEventHandlers } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import { standingRatingSlotIri } from '../../../services/main/src/modules/rating/observation.ts';
import type { Pool } from 'pg';

const work = 'https://rezics.com/id/00000000-1063-4000-8000-000000000001';
const context = 'https://rezics.com/id/00000000-1063-4000-8000-000000000002';
const mainVersion = 'https://rezics.com/id/00000000-1063-4000-8000-000000000003';
const owner = '00000000-1063-4000-8000-000000000004';
const base = { scope: 'global' as const, realm: null, context: null, owner: null };

test('G1063: every owner relay action has an explicit discovery/rating effect', async () => {
  const handlers = await discoverOutboxEventHandlers();
  for (const handler of handlers.values())
    for (const action of [handler.action, ...(handler.actions ?? [])]) {
      expect(DISCOVERY_EFFECTS[action], `${handler.type}: ${action}`).toBeDefined();
    }
  expect(discoveryEventEffect({ action: 'future.unclassified' }, base)).toBeUndefined();
});

test('G1063: ratings affect their Context and Mine slot; unrelated owner commands advance only coverage', () => {
  const rating = { action: 'rating.observation.set', work, mainVersion, ratingContext: context };
  expect(discoveryEventEffect(rating, base)).toBe('irrelevant');
  expect(discoveryEventEffect(rating, { ...base, context })).toBe('work');
  const mine = { ...base, scope: 'mine' as const, owner, context };
  expect(discoveryEventEffect({ ...rating, ratingSlot: 'another-slot' }, mine)).toBe('irrelevant');
  expect(
    discoveryEventEffect(
      { ...rating, ratingSlot: standingRatingSlotIri(owner, context, mainVersion) },
      mine,
    ),
  ).toBe('work');
  for (const action of ['relation.change', 'zone.edit', 'theme.activate', 'structure.project']) {
    expect(discoveryEventEffect({ action }, base)).toBe('irrelevant');
  }
  expect(
    discoveryEventEffect({ action: 'structure.command', commandAction: 'composition.seal' }, base),
  ).toBe('irrelevant');
  expect(
    discoveryEventEffect(
      { action: 'structure.command', commandAction: 'composition.restore' },
      base,
    ),
  ).toBe('scope');
  expect(discoveryEventEffect({ action: 'structure.command' }, base)).toBe('scope');
  expect(discoveryEventEffect({ action: 'semantic.change' }, base)).toBe('scope');
  expect(discoveryEventEffect({ action: 'work.edit', outcome: 'cancelled' }, base)).toBe(
    'irrelevant',
  );
});

test('G1063: complete relay coverage accepts Work-free events and fails closed on gaps, ordinals and unknown actions', async () => {
  const row = (sequence: string, action: string, ordinal = 0, target?: string) => ({
    sequence,
    batch_id: `batch-${sequence}`,
    routing_epoch: 'route',
    event_count: 1,
    event_id: `event-${sequence}`,
    envelope: {
      specversion: '1.0',
      id: `event-${sequence}`,
      source: 'https://rezics.com/services/main',
      data: {
        batchId: `batch-${sequence}`,
        routingEpoch: 'route',
        ordinal,
        sourcePosition: { dataEpoch: 'epoch', sequence },
        receipt: { action, outcome: 'succeeded', work: target },
      },
    },
  });
  let rows = [row('11', 'relation.change'), row('12', 'work.edit', 0, work)];
  const inputs = new DiscoveryRefreshInputs(
    { query: async () => ({ rows }) } as unknown as Pick<Pool, 'query'>,
    'consumer',
  );
  const position = { dataEpoch: 'epoch', sequence: '12' };
  expect(await inputs.read(position, '10', base)).toEqual({ works: [work], created: [] });
  rows = [row('11', 'relation.change'), row('12', 'theme.activate')];
  expect(await inputs.read(position, '10', base)).toEqual({ works: [], created: [] });
  rows = [row('12', 'work.edit', 0, work)];
  expect(await inputs.read(position, '10', base)).toBeNull();
  rows = [row('11', 'relation.change'), row('12', 'work.edit', 1, work)];
  expect(await inputs.read(position, '10', base)).toBeNull();
  rows = [row('11', 'relation.change'), row('12', 'future.command')];
  expect(await inputs.read(position, '10', base)).toBeNull();
});
