import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { RV } from '../src/modules/work/activate.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const stageId = '22222222-2222-4222-8222-222222222222';
const admissionId = '33333333-3333-4333-8333-333333333333';
const structure = 'https://rezics.com/id/44444444-4444-4444-8444-444444444444';
const generation = 'https://rezics.com/id/55555555-5555-4555-8555-555555555555';
const receipt = 'urn:rezics:receipt:structure-stage-test';
const eventId = 'urn:rezics:event:structure-stage-test';
const batch: MainOutboxBatch = {
  streamScope: MAIN_RELAY_STREAM_SCOPE,
  dataEpoch: epoch,
  sequence: '40',
  graphSequence: '900',
  batchId: 'urn:rezics:outbox:structure-stage-test',
  routingEpoch: 'routing',
  eventIds: [eventId],
};
type Kind = 'projection' | 'cancelled';

/** A SPARQL SELECT returns only variables it both binds and projects. The
 * receipt fixture must not supply fields the real graph query would omit. */
function selected(query: string, facts: Record<string, string>): SparqlResult {
  const select = query.match(/\bSELECT\s+([\s\S]*?)\bWHERE\b/)?.[1] ?? '';
  const variables = new Set(select.match(/\?[A-Za-z][A-Za-z0-9]*/g));
  return {
    results: {
      bindings: [
        Object.fromEntries(
          Object.entries(facts)
            .filter(([key]) => variables.has(`?${key}`))
            .map(([key, value]) => [key, { type: 'literal', value }]),
        ),
      ],
    },
  };
}

function fixture(
  kind: Kind,
  receiptOverrides: Record<string, string | undefined> = {},
  proofOverrides: Record<string, string> = {},
) {
  const projection = kind === 'projection';
  const action = projection ? 'structure.project' : 'structure.stage-cancel';
  const receiptFacts: Record<string, string | undefined> = {
    kind: `${RV}${projection ? 'StructureProjectionEvent' : 'StructureStageCancelledEvent'}`,
    ordinal: '0',
    action,
    receipt,
    outcome: `${RV}${projection ? 'Succeeded' : 'Cancelled'}`,
    digest: 'a'.repeat(64),
    epoch,
    sequence: batch.graphSequence!,
    stageId,
    ...(projection ? { admissionId, authorityEpoch: '7', scope: `work:edit:${structure}` } : {}),
    ...receiptOverrides,
  };
  const proof = {
    structure,
    generation,
    eventAction: action,
    eventStage: stageId,
    eventStructure: structure,
    eventGeneration: generation,
    ...(projection ? { batchIndex: '3', eventBatch: '3' } : {}),
    ...proofOverrides,
  };
  let proofReads = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const query = await request.text();
      if (query.includes('?kind ?ordinal ?action ?receipt')) {
        const facts = Object.fromEntries(
          Object.entries(receiptFacts).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        if (!/\?receipt\s+rv:stageId\s+\?stageId/.test(query)) delete facts.stageId;
        return Response.json(selected(query, facts));
      }
      if (query.includes('?eventStage')) {
        proofReads++;
        return Response.json(selected(query, proof));
      }
      throw new Error(`Unexpected graph query: ${query}`);
    },
  });
  return {
    graph: new FusekiClient(`http://127.0.0.1:${server.port}/rezics`),
    server,
    proofReads: () => proofReads,
  };
}

for (const kind of ['projection', 'cancelled'] as const) {
  test(`relay carries ${kind} stage identity from its terminal receipt and replays the same proved envelope`, async () => {
    const f = fixture(kind);
    try {
      const event = await readMainOutboxEnvelope(f.graph, batch, eventId);
      expect(event.data.sourcePosition).toEqual({
        datasetId: 'product',
        dataEpoch: epoch,
        sequence: '900',
      });
      expect(event.data.relayPosition).toEqual({
        streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: epoch,
        sequence: '40',
      });
      expect(event.data.receipt).toMatchObject({ id: receipt, requestDigest: 'a'.repeat(64) });
      if (kind === 'projection') {
        expect(event.data.receipt).toMatchObject({
          action: 'structure.project',
          outcome: 'succeeded',
          stageId,
          structure,
          generation,
          projectionBatch: '3',
          admissionId,
          authorityEpoch: '7',
          scope: `work:edit:${structure}`,
        });
        expect(event.data.receipt).not.toHaveProperty('systemProof');
      } else {
        expect(event.data.receipt).toMatchObject({
          action: 'structure.stage-cancel',
          outcome: 'cancelled',
          systemProof: { kind: 'structure-stage-cancelled', stageId, structure, generation },
        });
        expect(event.data.receipt).not.toHaveProperty('admissionId');
      }
      expect(await readMainOutboxEnvelope(f.graph, batch, eventId)).toEqual(event);
      expect(f.proofReads()).toBe(2);
    } finally {
      await f.server.stop(true);
    }
  });
}

for (const [label, receiptOverrides] of [
  ['missing stage identity', { stageId: undefined }],
  ['foreign receipt epoch', { epoch: 'foreign' }],
  ['foreign receipt sequence', { sequence: '901' }],
  ['missing Access admission', { admissionId: undefined }],
] as const) {
  test(`relay still refuses a projection receipt with ${label}`, async () => {
    const f = fixture('projection', receiptOverrides);
    try {
      await expect(readMainOutboxEnvelope(f.graph, batch, eventId)).rejects.toThrow();
      expect(f.proofReads()).toBe(0);
    } finally {
      await f.server.stop(true);
    }
  });
}

for (const [label, proofOverrides] of [
  ['stage identity', { eventStage: 'foreign-stage' }],
  ['structure', { eventStructure: 'urn:foreign:structure' }],
  ['generation', { eventGeneration: 'urn:foreign:generation' }],
  ['projection batch', { eventBatch: '4' }],
] as const) {
  test(`relay still refuses projection event/receipt ${label} mismatches`, async () => {
    const f = fixture('projection', {}, proofOverrides);
    try {
      await expect(readMainOutboxEnvelope(f.graph, batch, eventId)).rejects.toThrow(
        'Structure stage event differs from its graph proof',
      );
      expect(f.proofReads()).toBe(1);
    } finally {
      await f.server.stop(true);
    }
  });
}

test('relay refuses Access admission fields attached to a system stage cancellation', async () => {
  const f = fixture('cancelled', { admissionId });
  try {
    await expect(readMainOutboxEnvelope(f.graph, batch, eventId)).rejects.toThrow();
    expect(f.proofReads()).toBe(0);
  } finally {
    await f.server.stop(true);
  }
});
