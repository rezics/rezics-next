import { expect, test } from 'bun:test';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import {
  buildHeldGraphErasureCommand,
  GraphErasureConflict,
  GraphErasureUnavailable,
  graphErasureReceipt,
  readGraphErasureProof,
  suppressHeldGraphContentRevisions,
  type HeldGraphErasureProof,
  type HeldGraphErasureReplay,
  type ReleasedGraphErasureProof,
} from '../src/modules/erasure/graph.ts';
import { assertGraphErasure, graphLineageSequence, replayGraphErasure } from '../src/modules/erasure/replay-graph.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { DATASET, GRAPHS, RV, hash } from '../src/modules/work/activate.ts';

type Rows = NonNullable<SparqlResult['results']>['bindings'];
type Term = Rows[number][string];
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PUBLIC = 'urn:rezics:search:public', PRIVATE = 'urn:rezics:search:private';
const KEY = '3'.repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const erasureId = uuid(30), epoch = '7';
const uri = (value: string): Term => ({ type: 'uri', value });
const literal = (value: string, datatype = 'string'): Term => ({ type: 'literal', value, datatype: XSD + datatype });
const revision = (id: string) => `urn:rezics:content:revision:${id}`;

/** Controlled parser evidence only. This fixture never reports a native write
 * or a successful cross-owner recovery. The actual exported kernel reader and
 * erasure reader parse these query rows, rather than a permissive proof adapter. */
class ReleaseGraph extends FusekiClient {
  queries: { text: string; maxBytes?: number }[] = [];
  releaseRows: Rows = [];
  proofRows: Rows = [];
  units: Rows = [];
  releaseReads = 0;
  proofReads = 0;
  indexedReads = 0;
  commandCalls = 0;
  proofAvailable = true;
  unitsAvailable = true;
  afterInventory?: () => void;
  constructor() { super('http://released-erasure-proof.invalid'); }
  override async query(text: string, maxBytes?: number): Promise<SparqlResult> {
    this.queries.push({ text, maxBytes });
    if (text.includes('SELECT ?sequence') && text.includes('BIND(0 AS ?sequence)')) {
      return { results: { bindings: [] } }; // Actual captured hold is absent.
    }
    if (text.includes('SELECT ?graph ?subject ?predicate ?object')) {
      if (text.includes('VALUES (?graph ?subject)')) {
        this.proofReads++;
        const rows = structuredClone(this.proofRows);
        this.afterInventory?.();
        return this.proofAvailable ? { results: { bindings: rows } } : {};
      }
      if (text.includes('urn:rezics:receipt:restore-release:')) {
        this.releaseReads++;
        return { results: { bindings: structuredClone(this.releaseRows) } };
      }
    }
    if (text.includes('SELECT DISTINCT ?graph ?unit')) {
      this.indexedReads++;
      return this.unitsAvailable ? { results: { bindings: structuredClone(this.units) } } : {};
    }
    throw new Error('Unexpected released erasure fixture query');
  }
  override async command(_envelope: CommandEnvelope): Promise<never> {
    this.commandCalls++;
    throw new Error('Read-side fixture cannot commit native commands');
  }
  override async commandWithReceipt(_envelope: CommandEnvelope): Promise<never> {
    this.commandCalls++;
    throw new Error('Read-side fixture cannot commit native commands');
  }
}

function add(rows: Rows, graph: string, subject: string, facts: Record<string, Term>) {
  for (const [name, object] of Object.entries(facts)) rows.push({ graph: uri(graph), subject: uri(subject),
    predicate: uri(name === 'type' ? RDF_TYPE : RV + name), object });
}

function fixture(options: { own?: boolean; originalSequence?: string; originalEpoch?: string;
  targets?: number; paired?: boolean } = {}) {
  const graph = new ReleaseGraph(), paired = options.paired !== false;
  const captured: HeldGraphErasureProof = {
    cut: { dataEpoch: uuid(11), routingEpoch: '2', restoreCutover: `urn:rezics:restore:${uuid(11)}`,
      priorDataEpoch: uuid(12), priorSequence: '900' },
    accessHoldGeneration: '4', revisionIds: Array.from({ length: options.targets ?? 1 }, (_, i) => uuid(100 + i)),
    original: { receipt: graphErasureReceipt(erasureId), dataEpoch: options.originalEpoch ?? uuid(12),
      sequence: options.originalSequence ?? '850' },
  };
  const released: ReleasedGraphErasureProof['released'] = {
    lineage: { dataEpoch: captured.cut.dataEpoch, routingEpoch: captured.cut.routingEpoch },
    restoreCutover: captured.cut.restoreCutover,
    saved: { dataEpoch: uuid(12), graphSequence: '900', ...(paired
      ? { main: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: uuid(12), sequence: '4' } } : {}) },
    effective: { dataEpoch: uuid(12), graphSequence: '1200', ...(paired
      ? { main: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: uuid(12), sequence: '7' } } : {}) },
  };
  const proof: ReleasedGraphErasureProof = { released, captured };
  const releaseReceipt = `urn:rezics:receipt:restore-release:${hash(captured.cut.dataEpoch)}`;
  const releaseDigest = hash(JSON.stringify(paired
    ? { family: 'restore-release-v2', lineage: released.lineage, priorDataEpoch: released.effective.dataEpoch,
      priorSequence: released.effective.graphSequence, priorMainSequence: released.effective.main!.sequence,
      streamScope: MAIN_RELAY_STREAM_SCOPE }
    : { family: 'restore-release-v1', lineage: released.lineage,
      priorDataEpoch: released.effective.dataEpoch, priorSequence: released.effective.graphSequence }));
  add(graph.releaseRows, GRAPHS.control, DATASET, { dataEpoch: literal(captured.cut.dataEpoch),
    routingEpoch: literal('2'), sequence: literal('0', 'integer'), restoreCutover: uri(captured.cut.restoreCutover) });
  // The reader selects the Main stream subject only for paired releases; legacy v1 has none.
  if (paired) add(graph.releaseRows, GRAPHS.control, MAIN_RELAY_STREAM_SCOPE, {
    dataEpoch: literal(captured.cut.dataEpoch), streamSequence: literal('0', 'integer'),
    legacyThroughSequence: literal('0', 'integer') });
  add(graph.releaseRows, GRAPHS.control, captured.cut.restoreCutover, {
    type: uri(RV + 'RestoreCutover'), dataEpoch: literal(captured.cut.dataEpoch), priorDataEpoch: literal(uuid(12)),
    priorSequence: literal('900', 'integer'), reconciledPriorSequence: literal('1200', 'integer'),
    ...(paired ? { priorMainSequence: literal('4', 'integer'), reconciledPriorMainSequence: literal('7', 'integer') } : {}),
  });
  add(graph.releaseRows, GRAPHS.receipts, releaseReceipt, { type: uri(RV + 'OperationReceipt'),
    requestDigest: literal(releaseDigest), datasetId: uri(DATASET), dataEpoch: literal(captured.cut.dataEpoch),
    sequence: literal('0', 'integer'), ...(paired
      ? { priorMainSequence: literal('7', 'integer'), streamScope: literal(MAIN_RELAY_STREAM_SCOPE) } : {}) });
  for (const id of captured.revisionIds) add(graph.proofRows, GRAPHS.revisions, revision(id), {
    type: uri(RV + 'ErasedRevision'), erasureEpoch: literal(epoch, 'integer') });
  const originalDigest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch,
    targets: captured.revisionIds.map(revision).sort() }));
  add(graph.proofRows, GRAPHS.receipts, captured.original.receipt, {
    type: uri(RV + 'OperationReceipt'), requestDigest: literal(originalDigest), datasetId: uri(DATASET),
    dataEpoch: literal(captured.original.dataEpoch), sequence: literal(captured.original.sequence, 'integer'),
    outcome: uri(RV + 'Succeeded'), erasureId: literal(erasureId), erasureEpoch: literal(epoch, 'integer'),
  });
  // Derive only exact maintenance identity/fields from the real existing builder.
  // The fixture does not send the envelope or claim its signature committed.
  const maintenance = buildHeldGraphErasureCommand(erasureId, epoch, captured.revisionIds, captured, [], KEY);
  if (options.own) add(graph.proofRows, GRAPHS.receipts, maintenance.receipt, {
    type: uri(RV + 'OperationReceipt'), commandFamily: literal('rezics-erasure-restore-v1'),
    requestDigest: literal(maintenance.digest), datasetId: uri(DATASET), dataEpoch: literal(captured.cut.dataEpoch),
    sequence: literal('0', 'integer'), outcome: uri(RV + 'Succeeded'), restoredReceipt: uri(captured.original.receipt),
    restoreCutover: uri(captured.cut.restoreCutover), erasureId: literal(erasureId), erasureEpoch: literal(epoch, 'integer'),
  });
  const read = () => readGraphErasureProof(graph, released.lineage, erasureId, epoch, captured.revisionIds, proof);
  return { graph, captured, released, proof, maintenance, releaseReceipt, read };
}

for (const paired of [false, true]) {
  test(`released ${paired ? 'paired' : 'legacy'} pre-cut original-only parsing returns the positive historical graph tuple`, async () => {
    const f = fixture({ paired, originalSequence: '900' });
    expect(await f.read()).toEqual(f.captured.original);
    expect(f.graph.releaseReads).toBe(2);
    expect(f.graph.proofReads).toBe(1);
    expect(f.graph.indexedReads).toBe(1);
    expect(f.graph.commandCalls).toBe(0);
    expect(f.graph.proofRows.filter(row => row.subject!.value === f.captured.original.receipt)).toHaveLength(8);
    expect(f.graph.releaseRows.filter(row => row.subject!.value === f.releaseReceipt)).toHaveLength(paired ? 7 : 5);
    if (paired) expect(f.released.saved.main!.sequence).toBe('4');
    expect(f.released.saved.graphSequence).toBe('900');
    expect(f.released.effective.graphSequence).toBe('1200');
    expect(await graphLineageSequence(f.graph, f.released.lineage, f.released)).toBe('0');
    expect(await assertGraphErasure(f.graph, f.released.lineage, erasureId, epoch,
      f.captured.revisionIds, f.proof)).toBe(true);
    expect(f.graph.commandCalls).toBe(0);
  });
}

test('an original beyond saved but within effective needs the actual maintenance subject', async () => {
  const missing = fixture({ originalSequence: '1000' });
  await expect(missing.read()).rejects.toBeInstanceOf(GraphErasureUnavailable);
  expect(missing.graph.releaseReads).toBe(2);
  const complete = fixture({ originalSequence: '1000', own: true });
  expect(await complete.read()).toEqual(complete.captured.original);
  expect(complete.graph.proofRows.filter(row => row.subject!.value === complete.maintenance.receipt)).toHaveLength(11);
  expect(complete.graph.commandCalls).toBe(0);
});

test('an original from another epoch requires maintenance even with a smaller diagnostic sequence', async () => {
  const missing = fixture({ originalEpoch: uuid(99), originalSequence: '1' });
  await expect(missing.read()).rejects.toBeInstanceOf(GraphErasureUnavailable);
  const complete = fixture({ originalEpoch: uuid(99), originalSequence: '1', own: true });
  expect(await complete.read()).toEqual(complete.captured.original);
  expect(complete.graph.commandCalls).toBe(0);
});

const mismatches: { name: string; change: (f: ReturnType<typeof fixture>) => void }[] = [
  { name: 'saved captured cut', change: f => { f.captured.cut.priorSequence = '899'; } },
  { name: 'captured source epoch', change: f => { f.captured.cut.priorDataEpoch = uuid(98); } },
  { name: 'captured routing', change: f => { f.captured.cut.routingEpoch = '3'; } },
  { name: 'maintenance Access generation', change: f => { f.captured.accessHoldGeneration = '5'; } },
  { name: 'target set', change: f => { f.captured.revisionIds = [uuid(201)]; } },
  { name: 'original positive sequence', change: f => { f.captured.original.sequence = '1001'; } },
  { name: 'original epoch', change: f => { f.captured.original.dataEpoch = uuid(98); } },
  { name: 'original receipt', change: f => { f.captured.original.receipt = graphErasureReceipt(uuid(98)); } },
  { name: 'saved Main replaced by graph position', change: f => { f.released.saved.main!.sequence = '900'; } },
  { name: 'effective Main replaced by graph position', change: f => { f.released.effective.main!.sequence = '1200'; } },
];
for (const mismatch of mismatches) test(`released proof denies changed ${mismatch.name}`, async () => {
  const f = fixture({ own: true, originalSequence: '1000' });
  mismatch.change(f);
  await expect(f.read()).rejects.toThrow();
  expect(f.graph.commandCalls).toBe(0);
});

for (const family of ['original', 'tombstone', 'maintenance'] as const) {
  for (const fault of ['missing', 'extra', 'term-kind', 'datatype', 'competing'] as const) {
    test(`whole ${family} subject denies ${fault} facts`, async () => {
      const f = fixture({ own: family === 'maintenance', originalSequence: family === 'maintenance' ? '1000' : '850' });
      const subject = family === 'original' ? f.captured.original.receipt
        : family === 'maintenance' ? f.maintenance.receipt : revision(f.captured.revisionIds[0]!);
      const index = f.graph.proofRows.findIndex(row => row.subject!.value === subject
        && row.predicate!.value === RV + (family === 'maintenance' ? 'sequence' : 'erasureEpoch'));
      const row = f.graph.proofRows[index]!;
      if (fault === 'missing') f.graph.proofRows.splice(index, 1);
      if (fault === 'extra') f.graph.proofRows.push({ ...row, predicate: uri(RV + 'privateBody'), object: literal('unexpected') });
      if (fault === 'term-kind') row.object = uri(row.object!.value);
      if (fault === 'datatype') row.object = literal(row.object!.value);
      if (fault === 'competing') f.graph.proofRows.push({ ...row, object: literal('999', 'integer') });
      await expect(f.read()).rejects.toBeInstanceOf(GraphErasureConflict);
      expect(f.graph.proofReads).toBe(1);
      expect(f.graph.commandCalls).toBe(0);
    });
  }
}

test('a maintenance subject without the complete original cannot attest suppression', async () => {
  const f = fixture({ own: true, originalSequence: '1000' });
  f.graph.proofRows = f.graph.proofRows.filter(row => row.subject!.value !== f.captured.original.receipt);
  await expect(f.read()).rejects.toBeInstanceOf(GraphErasureConflict);
  expect(f.graph.commandCalls).toBe(0);
});

test('partial tombstone target sets deny while canonical string terms keep their RDF meaning', async () => {
  const f = fixture({ targets: 2 });
  for (const row of f.graph.proofRows) if (row.object!.datatype === XSD + 'string') delete row.object!.datatype;
  expect(await f.read()).toEqual(f.captured.original);
  f.graph.proofRows = f.graph.proofRows.filter(row => row.subject!.value !== revision(f.captured.revisionIds[1]!));
  await expect(f.read()).rejects.toBeInstanceOf(GraphErasureConflict);
});

for (const [scope, predicate] of [[PUBLIC, 'revision'], [PRIVATE, 'contentRevision']] as const) {
  test(`released proof denies remaining ${scope} ${predicate} indexed references`, async () => {
    const f = fixture();
    f.graph.units = [{ graph: uri(scope), unit: uri('urn:rezics:unit:still-exposed') }];
    await expect(f.read()).rejects.toBeInstanceOf(GraphErasureConflict);
    const query = f.graph.queries.find(item => item.text.includes('SELECT DISTINCT ?graph ?unit'))!.text;
    expect(query).toContain(`rv:${predicate}`);
    expect(query).toContain(scope);
    expect(f.graph.commandCalls).toBe(0);
  });
}

test('unavailable proof/indexed inventories and malformed indexed identity fail closed', async () => {
  for (const kind of ['proof', 'indexed', 'identity'] as const) {
    const f = fixture();
    if (kind === 'proof') f.graph.proofAvailable = false;
    if (kind === 'indexed') f.graph.unitsAvailable = false;
    if (kind === 'identity') f.graph.units = [{ graph: literal(PUBLIC), unit: uri('urn:rezics:unit:bad') }];
    await expect(f.read()).rejects.toBeInstanceOf(GraphErasureUnavailable);
    expect(f.graph.commandCalls).toBe(0);
  }
});

test('release evidence changed after inventory cannot return the historical proof', async () => {
  const f = fixture({ own: true, originalSequence: '1000' });
  f.graph.afterInventory = () => {
    f.graph.releaseRows = f.graph.releaseRows.filter(row => row.subject!.value !== f.releaseReceipt);
  };
  await expect(f.read()).rejects.toThrow('native graph release evidence changed during erasure proof read');
  expect(f.graph.releaseReads).toBe(2);
  expect(f.graph.proofReads).toBe(1);
  expect(f.graph.indexedReads).toBe(1);
  expect(f.graph.commandCalls).toBe(0);
});

test('missing release proof denies before erasure inventory and performs no mutation', async () => {
  const f = fixture();
  f.graph.releaseRows = f.graph.releaseRows.filter(row => row.subject!.value !== f.releaseReceipt);
  await expect(f.read()).rejects.toThrow('exact native graph release proof is unavailable');
  expect(f.graph.releaseReads).toBe(1);
  expect(f.graph.proofReads).toBe(0);
  expect(f.graph.commandCalls).toBe(0);
});

test('released control cannot enter held replay, read the signing key or send maintenance', async () => {
  const f = fixture({ own: true, originalSequence: '1000' });
  let signingReads = 0, sends = 0, authorizations = 0;
  const held: HeldGraphErasureReplay = { ...f.captured,
    get signingKey() { signingReads++; return KEY; },
    maintenance: { command: async (_command: CommandEnvelope): Promise<never> => {
      sends++; throw new Error('Released proof must never send maintenance');
    } }, assertCurrent: async () => { authorizations++; } };
  await expect(suppressHeldGraphContentRevisions(f.graph, erasureId, epoch, f.captured.revisionIds, held))
    .rejects.toThrow('held graph cut is unavailable');
  expect(await replayGraphErasure(f.graph, f.released.lineage, erasureId, epoch,
    f.captured.revisionIds, true, held)).toBe('conflict');
  expect(authorizations).toBe(1);
  expect(signingReads).toBe(0);
  expect(sends).toBe(0);
  expect(f.graph.commandCalls).toBe(0);
});

test('64 targets fit the complete subject bound and one extra row is refused', async () => {
  const f = fixture({ targets: 64, own: true, originalSequence: '1000' });
  expect(await f.read()).toEqual(f.captured.original);
  expect(f.graph.proofRows).toHaveLength(2 * 64 + 8 + 11);
  const inventory = f.graph.queries.find(item => item.text.includes('VALUES (?graph ?subject)'))!;
  expect(inventory.text).toContain('LIMIT 148');
  expect(inventory.maxBytes).toBe(65_536);
  f.graph.proofRows.push(structuredClone(f.graph.proofRows[0]!));
  await expect(f.read()).rejects.toThrow('erasure proof inventory exceeds its exact bound');
  expect(f.graph.commandCalls).toBe(0);
});

test('65 targets, duplicate targets and over-64 indexed fanout are refused', async () => {
  const f = fixture({ targets: 64 });
  const oversized = [...f.captured.revisionIds, uuid(200)];
  await expect(readGraphErasureProof(f.graph, f.released.lineage, erasureId, epoch, oversized,
    { released: f.released, captured: { ...f.captured, revisionIds: oversized } })).rejects.toThrow('invalid graph targets');
  const duplicate = [f.captured.revisionIds[0]!, f.captured.revisionIds[0]!];
  await expect(readGraphErasureProof(f.graph, f.released.lineage, erasureId, epoch, duplicate,
    { released: f.released, captured: { ...f.captured, revisionIds: duplicate } })).rejects.toThrow('invalid graph targets');
  expect(f.graph.queries).toHaveLength(0);
  f.graph.units = Array.from({ length: 65 }, (_, i) => ({ graph: uri(PUBLIC), unit: uri(`urn:rezics:unit:${i}`) }));
  await expect(f.read()).rejects.toBeInstanceOf(GraphErasureUnavailable);
  expect(f.graph.queries.find(item => item.text.includes('SELECT DISTINCT ?graph ?unit'))!.text).toContain('LIMIT 65');
  expect(f.graph.commandCalls).toBe(0);
});
