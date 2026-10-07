import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  CommandForbidden,
  CommandOutcomeUnknown,
  type CommandEnvelope,
  type SparqlResult,
} from '../src/infrastructure/fuseki.ts';
import {
  buildHeldGraphErasureCommand,
  graphErasureReceipt,
  graphRevisionSuppressed,
  heldErasureMaintenanceClient,
  heldGraphErasureControl,
  probeHeldGraphErasureProof,
  readGraphErasureProof,
  suppressHeldGraphContentRevisions,
  type HeldGraphErasureProof,
  type HeldGraphErasureReplay,
} from '../src/modules/erasure/graph.ts';
import {
  assertGraphErasure,
  graphLineageSequence,
  replayGraphErasure,
} from '../src/modules/erasure/replay-graph.ts';
import { DATASET, GRAPHS, RV, hash } from '../src/modules/work/activate.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const PUBLIC = 'urn:rezics:search:public';
const PRIVATE = 'urn:rezics:search:private';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const KEY = '3'.repeat(64);
const erasureId = uuid(13),
  epoch = '7';
const literal = (value: string, datatype = `${XSD}string`) => ({
  type: 'literal',
  value,
  datatype,
});
const uri = (value: string) => ({ type: 'uri', value });
const basis = (): HeldGraphErasureProof => ({
  cut: {
    dataEpoch: uuid(11),
    routingEpoch: '2',
    restoreCutover: `urn:rezics:restore:${uuid(11)}`,
    priorDataEpoch: uuid(12),
    priorSequence: '3',
  },
  accessHoldGeneration: '4',
  revisionIds: [uuid(1), uuid(2)],
  original: { receipt: graphErasureReceipt(erasureId), dataEpoch: uuid(12), sequence: '9' },
});
const originalDigest = (held: HeldGraphErasureProof) =>
  hash(
    JSON.stringify({
      family: 'erasure-graph-v1',
      erasureId,
      epoch,
      targets: held.revisionIds.map((id) => `urn:rezics:content:revision:${id}`).sort(),
    }),
  );

/** Read-side proof fixtures only; this client never pretends that a native write succeeded. */
class ProofGraph extends FusekiClient {
  queries: string[] = [];
  sequenceRows: NonNullable<SparqlResult['results']>['bindings'] = [
    { sequence: literal('0', `${XSD}integer`) },
  ];
  proofRows: NonNullable<SparqlResult['results']>['bindings'] = [];
  units: NonNullable<SparqlResult['results']>['bindings'] = [];
  constructor() {
    super('http://held-proof.invalid');
  }
  override async query(query: string): Promise<SparqlResult> {
    this.queries.push(query);
    if (query.includes('SELECT ?sequence')) return { results: { bindings: this.sequenceRows } };
    if (query.includes('SELECT ?graph ?subject ?predicate ?object'))
      return { results: { bindings: this.proofRows } };
    if (query.includes('SELECT DISTINCT ?graph ?unit'))
      return { results: { bindings: this.units } };
    throw new Error('Unexpected held proof query');
  }
}
function rows(held: HeldGraphErasureProof, own = false) {
  const result: NonNullable<SparqlResult['results']>['bindings'] = [];
  const add = (
    graph: string,
    subject: string,
    predicate: string,
    object: ReturnType<typeof literal> | ReturnType<typeof uri>,
  ) =>
    result.push({
      graph: uri(graph),
      subject: uri(subject),
      predicate: uri(
        predicate === 'type'
          ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          : `${RV}${predicate}`,
      ),
      object,
    });
  for (const id of held.revisionIds) {
    add(GRAPHS.revisions, `urn:rezics:content:revision:${id}`, 'type', uri(`${RV}ErasedRevision`));
    add(
      GRAPHS.revisions,
      `urn:rezics:content:revision:${id}`,
      'erasureEpoch',
      literal(epoch, `${XSD}integer`),
    );
  }
  for (const [predicate, object] of Object.entries({
    type: uri(`${RV}OperationReceipt`),
    requestDigest: literal(originalDigest(held)),
    datasetId: uri(DATASET),
    dataEpoch: literal(held.original.dataEpoch),
    sequence: literal(held.original.sequence, `${XSD}integer`),
    outcome: uri(`${RV}Succeeded`),
    erasureId: literal(erasureId),
    erasureEpoch: literal(epoch, `${XSD}integer`),
  }))
    add(GRAPHS.receipts, held.original.receipt, predicate, object);
  if (own) {
    const command = buildHeldGraphErasureCommand(erasureId, epoch, held.revisionIds, held, [], KEY);
    for (const [predicate, object] of Object.entries({
      type: uri(`${RV}OperationReceipt`),
      commandFamily: literal('rezics-erasure-restore-v1'),
      requestDigest: literal(command.digest),
      datasetId: uri(DATASET),
      dataEpoch: literal(held.cut.dataEpoch),
      sequence: literal('0', `${XSD}integer`),
      outcome: uri(`${RV}Succeeded`),
      restoredReceipt: uri(held.original.receipt),
      restoreCutover: uri(held.cut.restoreCutover),
      erasureId: literal(erasureId),
      erasureEpoch: literal(epoch, `${XSD}integer`),
    }))
      add(GRAPHS.receipts, command.receipt, predicate, object);
  }
  return result;
}
function context(held = basis()) {
  const sent: CommandEnvelope[] = [],
    authorized: unknown[] = [];
  const options: HeldGraphErasureReplay = {
    ...held,
    signingKey: KEY,
    assertCurrent: async (entry) => {
      authorized.push(entry);
    },
    maintenance: {
      command: async (envelope) => {
        sent.push(envelope);
        throw new CommandForbidden('core hook unavailable');
      },
    },
  };
  return { options, sent, authorized };
}

test('held body preserves exact native 17 fields, old position and zero restore receipt without control/outbox writes', () => {
  const held = basis(),
    expiry = new Date(Date.now() + 60_000).toISOString();
  const units = [
    { graph: PUBLIC as typeof PUBLIC, unit: 'urn:rezics:content:match-unit:one' },
    { graph: PRIVATE as typeof PRIVATE, unit: 'urn:rezics:content:private-unit:two' },
  ];
  const command = buildHeldGraphErasureCommand(
    erasureId,
    epoch,
    [...held.revisionIds].reverse(),
    held,
    units,
    KEY,
    expiry,
  );
  const payload = command.titleAdmission!.payload;
  const claims = JSON.parse(payload);
  expect(claims).toEqual([
    'rezics-erasure-restore-v1',
    command.receipt,
    command.digest,
    hash(command.update),
    held.cut.dataEpoch,
    held.cut.routingEpoch,
    held.cut.restoreCutover,
    '4',
    erasureId,
    epoch,
    held.revisionIds.map((id) => `urn:rezics:content:revision:${id}`),
    held.original.dataEpoch,
    '9',
    originalDigest(held),
    expiry,
    held.cut.priorDataEpoch,
    '3',
  ]);
  expect(command.titleAdmission!.signature).toBe(
    createHmac('sha256', KEY).update(payload).digest('hex'),
  );
  expect(command.titleAdmission!.signature).not.toBe(
    createHmac('sha256', Buffer.from(KEY, 'hex')).update(payload).digest('hex'),
  );
  const writes = command.update.split('WHERE')[0]!;
  expect(writes).not.toContain(GRAPHS.control);
  expect(writes).not.toContain(GRAPHS.outbox);
  expect(command.update).not.toContain('OPTIONAL');
  expect(command.update).not.toContain('?next');
  expect(command.update).not.toContain('reconciledPriorSequence');
  expect(command.update.match(/ UNION /g)).toHaveLength(1);
  expect(writes).toContain(`<${held.original.receipt}> rv:sequence "9"^^xsd:integer`);
  expect(writes).toContain(`<${command.receipt}> rv:sequence "0"^^xsd:integer`);
  expect(command.validations).toEqual([]);
  const refreshed = buildHeldGraphErasureCommand(
    erasureId,
    epoch,
    held.revisionIds,
    held,
    [],
    KEY,
    new Date(Date.now() + 120_000).toISOString(),
  );
  expect(refreshed.receipt).toBe(command.receipt);
  expect(refreshed.digest).toBe(command.digest);
  expect(refreshed.titleAdmission!.payload).not.toBe(payload);
});

test('held builder refuses missing, mixed, duplicate, oversized and expired evidence', () => {
  const held = basis();
  for (const ids of [
    [],
    [uuid(1), uuid(1)],
    ['foreign'],
    Array.from({ length: 65 }, (_, i) => uuid(i + 1)),
  ])
    expect(() =>
      buildHeldGraphErasureCommand(erasureId, epoch, ids, { ...held, revisionIds: ids }, [], KEY),
    ).toThrow();
  for (const bad of [
    { ...held, original: { ...held.original, sequence: '0' } },
    { ...held, original: { ...held.original, dataEpoch: held.cut.dataEpoch } },
    { ...held, cut: { ...held.cut, restoreCutover: 'urn:rezics:restore:foreign' } },
    { ...held, accessHoldGeneration: '-1' },
  ])
    expect(() =>
      buildHeldGraphErasureCommand(erasureId, epoch, held.revisionIds, bad, [], KEY),
    ).toThrow();
  expect(() =>
    buildHeldGraphErasureCommand(erasureId, '0', held.revisionIds, held, [], KEY),
  ).toThrow();
  expect(() =>
    buildHeldGraphErasureCommand(
      erasureId,
      epoch,
      held.revisionIds,
      held,
      [],
      KEY,
      '2000-01-01T00:00:00Z',
    ),
  ).toThrow();
  const unit = { graph: PUBLIC as typeof PUBLIC, unit: 'urn:rezics:content:match-unit:one' };
  expect(() =>
    buildHeldGraphErasureCommand(erasureId, epoch, held.revisionIds, held, [unit, unit], KEY),
  ).toThrow();
});

test('held sequence is explicit and rejects missing, duplicate or nonzero results; old unheld guard remains', async () => {
  const graph = new ProofGraph(),
    held = basis();
  expect(await graphLineageSequence(graph, held.cut, held.cut)).toBe('0');
  expect(graph.queries.at(-1)).toContain('rv:restoreHold true');
  expect(heldGraphErasureControl(held.cut)).toContain('sameTerm');
  expect(heldGraphErasureControl(held.cut)).toContain('rv:priorSequence 3');
  for (const bindings of [
    [],
    [{ sequence: literal('1', `${XSD}integer`) }],
    [{ sequence: literal('0') }],
    [graph.sequenceRows[0]!, graph.sequenceRows[0]!],
  ]) {
    graph.sequenceRows = bindings;
    expect(await graphLineageSequence(graph, held.cut, held.cut)).toBeNull();
  }
  graph.sequenceRows = [{ sequence: literal('6', `${XSD}integer`) }];
  expect(await graphLineageSequence(graph, held.cut)).toBe('6');
  expect(graph.queries.at(-1)).toContain('FILTER NOT EXISTS');
  expect(graph.queries.at(-1)).not.toContain('BIND(0 AS ?sequence)');
});

test('held proof returns the exact positive historical proof and requires full tombstone/receipt subjects', async () => {
  const graph = new ProofGraph(),
    held = basis();
  graph.proofRows = rows(held);
  expect(
    await readGraphErasureProof(graph, held.cut, erasureId, epoch, held.revisionIds, held),
  ).toEqual(held.original);
  expect(
    await graphRevisionSuppressed(
      graph,
      held.cut,
      held.revisionIds[0]!,
      erasureId,
      epoch,
      held.original,
      held,
    ),
  ).toBe(true);
  expect(
    await probeHeldGraphErasureProof(graph, erasureId, epoch, held.revisionIds, held, true),
  ).toBeNull();
  graph.proofRows = rows(held, true);
  expect(
    await probeHeldGraphErasureProof(graph, erasureId, epoch, held.revisionIds, held, true),
  ).toEqual(held.original);
  const original = graph.proofRows;
  for (const bad of [
    original.slice(1),
    [...original, original[0]!],
    [
      ...original,
      { ...original[0]!, predicate: uri(`${RV}privateBody`), object: literal('unexpected') },
    ],
    original.map((row, i) => (i === 1 ? { ...row, object: literal('8', `${XSD}integer`) } : row)),
    original.map((row, i) => (i === 1 ? { ...row, object: literal(epoch) } : row)),
    original.map((row, i) => (i === 0 ? { ...row, subject: uri('urn:foreign') } : row)),
  ]) {
    graph.proofRows = bad;
    await expect(
      readGraphErasureProof(graph, held.cut, erasureId, epoch, held.revisionIds, held),
    ).rejects.toThrow();
  }
  graph.proofRows = rows(held);
  graph.units = [{ graph: uri(PRIVATE), unit: uri('urn:rezics:content:private-unit:stale') }];
  await expect(
    readGraphErasureProof(graph, held.cut, erasureId, epoch, held.revisionIds, held),
  ).rejects.toThrow();
});

test('source-cut missing proof denies, while a verified pre-erasure cut remains eligible for bounded replay', async () => {
  const graph = new ProofGraph(),
    held = basis();
  expect(
    await probeHeldGraphErasureProof(graph, erasureId, epoch, held.revisionIds, held),
  ).toBeNull();
  await expect(
    probeHeldGraphErasureProof(graph, erasureId, epoch, held.revisionIds, {
      ...held,
      cut: { ...held.cut, priorSequence: '9' },
    }),
  ).rejects.toThrow();
  graph.proofRows = rows(held).slice(0, 2);
  await expect(
    probeHeldGraphErasureProof(graph, erasureId, epoch, held.revisionIds, held),
  ).rejects.toThrow();
});

test('owner authorization and explicit maintenance refusal keep replay held; no success or ordinary fallback is fabricated', async () => {
  const graph = new ProofGraph(),
    f = context();
  await expect(
    suppressHeldGraphContentRevisions(graph, erasureId, epoch, f.options.revisionIds, f.options),
  ).rejects.toThrow('capability unavailable');
  expect(f.sent).toHaveLength(1);
  expect(f.authorized.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(f.authorized)).not.toContain(KEY);
  expect(
    await replayGraphErasure(
      graph,
      f.options.cut,
      erasureId,
      epoch,
      f.options.revisionIds,
      true,
      f.options,
    ),
  ).toBe('conflict');
  const denied = context();
  denied.options.assertCurrent = async () => {
    throw new Error('current journal or owner hold differs');
  };
  await expect(
    suppressHeldGraphContentRevisions(
      graph,
      erasureId,
      epoch,
      denied.options.revisionIds,
      denied.options,
    ),
  ).rejects.toThrow();
  expect(denied.sent).toHaveLength(0);
  expect(
    await assertGraphErasure(
      graph,
      denied.options.cut,
      erasureId,
      epoch,
      denied.options.revisionIds,
      denied.options,
    ),
  ).toBe(false);
});

test('ambiguous transport retries require an exact maintenance receipt, with fresh signatures and no digest-only success', async () => {
  const graph = new ProofGraph(),
    f = context();
  f.options.maintenance.command = async (envelope) => {
    f.sent.push(envelope);
    // This simulates only an unavailable transport and read-side original proof;
    // it deliberately never supplies HTTP/native committed status.
    graph.proofRows = rows(f.options);
    throw new CommandOutcomeUnknown('core hook not committed');
  };
  await expect(
    suppressHeldGraphContentRevisions(graph, erasureId, epoch, f.options.revisionIds, f.options),
  ).rejects.toThrow('proof is unavailable');
  expect(f.sent).toHaveLength(3);
  expect(new Set(f.sent.map((command) => command.receipt)).size).toBe(1);
  expect(f.sent.every((command) => command.titleAdmission?.payload)).toBe(true);
});

test('maintenance client rejects malformed capability before any transport', () => {
  expect(() => heldErasureMaintenanceClient('http://unavailable.invalid', 'ordinary')).toThrow();
  expect(heldErasureMaintenanceClient('http://unavailable.invalid', '4'.repeat(64))).toBeInstanceOf(
    FusekiClient,
  );
});

test('existing maintenance proof still requires renewed native authorization on a replay invocation', async () => {
  const graph = new ProofGraph(),
    f = context();
  graph.proofRows = rows(f.options, true);
  await expect(
    suppressHeldGraphContentRevisions(graph, erasureId, epoch, f.options.revisionIds, f.options),
  ).rejects.toThrow('capability unavailable');
  expect(f.sent).toHaveLength(1);
  expect(
    await replayGraphErasure(
      graph,
      f.options.cut,
      erasureId,
      epoch,
      f.options.revisionIds,
      true,
      f.options,
    ),
  ).toBe('conflict');
  expect(f.sent).toHaveLength(2);
  f.options.maintenance.command = async (envelope) => {
    f.sent.push(envelope);
    throw new Error('known request rejection');
  };
  await expect(
    suppressHeldGraphContentRevisions(graph, erasureId, epoch, f.options.revisionIds, f.options),
  ).rejects.toThrow('request was not accepted');
  expect(f.sent).toHaveLength(3);
});

test('hold drift during owner authorization prevents signing or sending', async () => {
  const graph = new ProofGraph(),
    f = context();
  f.options.assertCurrent = async () => {
    graph.sequenceRows = [];
  };
  await expect(
    suppressHeldGraphContentRevisions(graph, erasureId, epoch, f.options.revisionIds, f.options),
  ).rejects.toThrow();
  expect(f.sent).toHaveLength(0);
});

test('maintenance-only client sends the maintenance bearer to a refusing endpoint without claiming native success', async () => {
  const held = basis(),
    envelope = buildHeldGraphErasureCommand(erasureId, epoch, held.revisionIds, held, [], KEY);
  const saved = globalThis.fetch;
  let authorization: string | null = null,
    captured: unknown;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get('authorization');
    captured = JSON.parse(String(init?.body));
    return new Response('', { status: 403 });
  }) as typeof fetch;
  try {
    await expect(
      heldErasureMaintenanceClient('http://refusing.invalid', '4'.repeat(64)).command(envelope),
    ).rejects.toBeInstanceOf(CommandForbidden);
    expect(String(authorization)).toBe(`Bearer ${'4'.repeat(64)}`);
    expect(captured).toEqual(envelope);
  } finally {
    globalThis.fetch = saved;
  }
});

test('known noncommitted native statuses cannot resolve through an old maintenance receipt', async () => {
  const graph = new ProofGraph(),
    f = context();
  graph.proofRows = rows(f.options, true);
  f.options.maintenance.command = async (envelope) => {
    f.sent.push(envelope);
    return { status: 'guard-unmatched' };
  };
  await expect(
    suppressHeldGraphContentRevisions(graph, erasureId, epoch, f.options.revisionIds, f.options),
  ).rejects.toThrow('proof is unavailable');
  expect(f.sent).toHaveLength(3);
});
