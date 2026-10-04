import { expect, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { OutboxIncomplete, readMainOutboxEnvelope } from '../src/modules/outbox/relay.ts';

const RV = 'https://rezics.com/vocab/';
const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const eventId = 'urn:rezics:event:target-rating',
  batch = {
    batchId: 'urn:rezics:outbox:target-rating',
    dataEpoch: 'epoch',
    routingEpoch: 'route',
    sequence: '42',
    eventIds: [eventId],
  };
const row = {
  kind: `${RV}RatingObservationChangedEvent`,
  ordinal: '0',
  action: 'rating.observation.set',
  receipt: 'urn:rezics:rating-receipt:target',
  eventOperation: id(1),
  outcome: `${RV}Succeeded`,
  admissionId: id(2).slice(-36),
  digest: 'a'.repeat(64),
  authorityEpoch: '0',
  scope: `rating:observe:${id(3)}`,
  epoch: 'epoch',
  sequence: '42',
  operation: id(1),
  realm: id(4),
  contextRevision: id(5),
  ratingContext: id(3),
  ratingSlot: 'urn:rezics:rating-slot:target',
  ratingObservation: id(6),
  observationRevision: id(7),
  ratingAvailability: `${RV}Available`,
  ratingValue: '8',
  target: id(8),
  eventRatingContext: id(3),
  eventRatingObservation: id(6),
};
const graph = (override: Record<string, string | undefined> = {}) =>
  ({
    query: async (query: string) => {
      if (query.includes('SELECT ?manifest'))
        return {
          results: {
            bindings: [{ manifest: { type: 'uri', value: `urn:rezics:sha256:${'b'.repeat(64)}` } }],
          },
        };
      const values = { ...row, ...override };
      return {
        results: {
          bindings: [
            Object.fromEntries(
              Object.entries(values).flatMap(([key, value]) =>
                value === undefined ? [] : [[key, { type: 'literal', value }]],
              ),
            ),
          ],
        },
      };
    },
  }) as unknown as FusekiClient;

test('relay delivers exact-target ratings with target and no Work or Main Version', async () => {
  const delivered = await readMainOutboxEnvelope(graph(), batch, eventId);
  expect(delivered.type).toBe('com.rezics.rating.observation-changed.v1');
  expect(delivered.data.receipt).toMatchObject({ target: id(8), ratingValue: 8 });
  expect(delivered.data.receipt).not.toHaveProperty('work');
  expect(delivered.data.receipt).not.toHaveProperty('mainVersion');
  expect(
    (
      await readMainOutboxEnvelope(
        graph({ ratingAvailability: `${RV}Withdrawn`, ratingValue: undefined }),
        batch,
        eventId,
      )
    ).data.receipt,
  ).toMatchObject({ target: id(8), ratingAvailability: 'withdrawn' });
});

test('relay retains the Work/Main branch and refuses mixed, missing or malformed target identities', async () => {
  expect(
    (
      await readMainOutboxEnvelope(
        graph({ target: undefined, work: id(9), main: id(10) }),
        batch,
        eventId,
      )
    ).data.receipt,
  ).toMatchObject({ work: id(9), mainVersion: id(10) });
  for (const override of [
    { target: undefined },
    { work: id(9) },
    { main: id(10) },
    { target: 'bad:target' },
    { ratingValue: '11' },
  ]) {
    await expect(readMainOutboxEnvelope(graph(override), batch, eventId)).rejects.toBeInstanceOf(
      OutboxIncomplete,
    );
  }
});
