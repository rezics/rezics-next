import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope,
  type CommandHealth, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_CONTEXT_PROFILE, CLASSIFICATION_CONTEXT_V2_PROFILE,
  CLASSIFICATION_INHERIT_POLICY, classificationContextDigest,
  createClassificationContext, readRealmClassificationContext, readClassificationContextReceipt,
  sealClassificationContextAdmission,
  type CreateClassificationContextInput } from '../src/modules/classification/context.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionDigest,
  classificationDecisionReceiptIri, classificationDecisionSlotIri } from '../src/modules/classification/decision.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../src/modules/classification/proposition.ts';
import * as relay from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { STATEMENT_CONVERSION_COST } from '../src/modules/statement/populated-conversion.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE, STATEMENT_PROFILE } from '../src/modules/statement/schema.ts';
import { DATASET, GRAPHS, RV, hash, prepareComponent,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readComponentState } from '../src/modules/work/history.ts';
import { reconcileRetainedAdmissionCancellation, reconcileRetainedClassificationContext,
  reconcileRetainedClassificationDecision, RetainedEffectConflict } from '../src/modules/work/reconcile-restored.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const epoch = 'restored-epoch', routingEpoch = 'restored-routing', retainedEpoch = 'retained-epoch';
const sequence = '41', prefix = 'urn:rezics:name-migration:statement-upgrade:restore:';
const rows = (values: Record<string, string>[]): SparqlResult => ({ results: {
  bindings: values.map(value => Object.fromEntries(Object.entries(value)
    .map(([key, text]) => [key, { type: 'uri' as const, value: text }]))) } });
const field = (text: string, predicate: string) => {
  const value = text.match(new RegExp(`rv:${predicate} <([^>]+)>`))?.[1];
  if (!value) throw new Error(`Missing command field ${predicate}`);
  return value;
};

interface Conversion {
  statement: string; revision: string; slot: string; decision: string; meaningKey: string;
}

/** Simulates only committed native effects; /update is absent on the assembler. */
class RestoreFuseki extends FusekiClient {
  commands: CommandEnvelope[] = [];
  queries: string[] = [];
  terminal: Record<string, string> | null = null;
  conversion: Conversion | null = null;
  cursor = '40';
  nativeHead: string | null = null;
  graphHeld = true;
  denyProof = false;
  missingConversion = false;
  staleNext = false;
  interruptBefore = false;
  loseResponse = false;
  definitionManifest = '';
  terminalOnCommit: Record<string, string> = {};
  rawUpdates = 0;
  constructor() { super('http://localhost:1/product'); }
  override async update(): Promise<void> {
    this.rawUpdates++;
    throw new Error('raw update endpoint is unavailable');
  }
  override async commandHealth(): Promise<CommandHealth> {
    return { moduleVersion: COMMAND_MODULE_VERSION, instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256])) };
  }
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    if (this.interruptBefore) {
      this.interruptBefore = false;
      throw new CommandOutcomeUnknown('interrupted before native transaction');
    }
    if (!this.graphHeld || this.staleNext) {
      if (this.staleNext) this.nativeHead = id(99);
      this.staleNext = false;
      return { status: 'guard-unmatched' };
    }
    const conversion = {
      statement: field(envelope.update, 'statement'), revision: field(envelope.update, 'statementRevision'),
      slot: field(envelope.update, 'decisionSlot'), decision: field(envelope.update, 'statementDecision'),
      meaningKey: field(envelope.update, 'meaningKey'),
    };
    this.conversion = conversion;
    this.nativeHead = conversion.decision;
    this.terminal = { ...this.terminalOnCommit };
    this.cursor = sequence;
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new CommandOutcomeUnknown('lost committed restore response');
    }
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: epoch, sequence: '0' } };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?manifest ?profile')) {
      return rows([{ manifest: this.definitionManifest, profile: CLASSIFICATION_PROPOSITION_PROFILE }]);
    }
    if (sparql.includes('?outcome ?reason ?digest ?id ?epoch')) return rows(this.terminal ? [this.terminal] : []);
    if (sparql.includes('SELECT ?statement ?revision ?slot ?decision ?meaningKey')) {
      return rows(this.conversion && !this.missingConversion ? [{ ...this.conversion }] : []);
    }
    if (sparql.includes('SELECT ?head WHERE')) return rows(this.nativeHead ? [{ head: this.nativeHead }] : []);
    if (sparql.includes('SELECT ?cursor WHERE')) return rows([{ cursor: this.cursor }]);
    if (sparql.includes('ASK') && sparql.includes('rv:restoredReceipt')) {
      return { boolean: !!this.conversion && !!this.terminal && !this.denyProof };
    }
    if (sparql.includes('ASK') && sparql.includes('rv:decisionHead')) {
      return { boolean: !!this.conversion && this.nativeHead === this.conversion.decision };
    }
    if (sparql.includes('ASK') && sparql.includes('rv:meaningKey') && sparql.includes('rv:head')) {
      return { boolean: !!this.conversion };
    }
    if (sparql.includes('ASK') && sparql.includes('a rv:ClassificationApplication')) return { boolean: false };
    // This held cut records only the diagnostic prior sequence.
    if (sparql.includes('SELECT ?saved ?savedMain WHERE')) return rows([{ saved: '0' }]);
    throw new Error(`Unexpected restore query: ${sparql}`);
  }
}

function fixture(outcome: 'accepted' | 'rejected' = 'accepted', predecessor: string | null = null) {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join('.temp', 'classification-restore-test-'));
  const fuseki = new RestoreFuseki();
  const env: WorkActivationEnvironment = { fuseki, lineage: { dataEpoch: epoch, routingEpoch }, objectDirectory: directory };
  const slot = classificationDecisionSlotIri(id(2), id(3), GLOBAL_CLASSIFICATION_CONTEXT);
  const admissionId = '00000000-0000-4000-8000-000000000100';
  const payload = { work: id(1), mainVersion: id(2), sense: id(3), senseRevision: id(6),
    application: id(7), decision: id(8), slot, context: GLOBAL_CLASSIFICATION_CONTEXT,
    realm: null, contextRevision: null, predecessor, proposer: id(4), decider: id(5),
    outcome, policy: CLASSIFICATION_DIRECT_DECISION_PROFILE };
  const receipt = { id: classificationDecisionReceiptIri(admissionId), admissionId,
    action: 'classification.decision.set' as const, outcome: 'succeeded' as const,
    authorityEpoch: '3', scope: 'classification:decide:global', operation: id(9),
    work: payload.work, mainVersion: payload.mainVersion, sense: payload.sense,
    classificationContext: payload.context, application: payload.application, decision: payload.decision,
    slot, decisionOutcome: outcome, ...(predecessor ? { expectedHead: predecessor } : {}),
    requestDigest: classificationDecisionDigest({ context: { kind: 'global' }, work: payload.work,
      mainVersion: payload.mainVersion, sense: payload.sense, expectedDecisionHead: predecessor,
      outcome, actingSubject: payload.decider }), decisionManifest: '' };
  receipt.decisionManifest = `urn:rezics:sha256:${prepareComponent(directory, payload.application, payload,
    CLASSIFICATION_DIRECT_DECISION_PROFILE)}`;
  fuseki.definitionManifest = `urn:rezics:sha256:${prepareComponent(directory, payload.sense,
    { concept: id(10), revision: payload.senseRevision }, CLASSIFICATION_PROPOSITION_PROFILE)}`;
  fuseki.terminalOnCommit = { outcome: `${RV}Succeeded`, digest: receipt.requestDigest, id: admissionId,
    epoch: receipt.authorityEpoch, scope: receipt.scope, dataEpoch: retainedEpoch, sequence,
    operation: receipt.operation, work: payload.work, main: payload.mainVersion, sense: payload.sense,
    context: payload.context, slot, application: payload.application, decision: payload.decision,
    decisionOutcome: `${RV}${outcome === 'accepted' ? 'Accepted' : 'Rejected'}`,
    ...(predecessor ? { expectedHead: predecessor } : {}) };
  const eventId = `urn:rezics:event:${hash(receipt.operation)}`;
  const envelope: relay.MainCloudEvent = { specversion: '1.0', id: eventId,
    source: 'https://rezics.com/services/main', type: 'com.rezics.classification.decision-changed.v1',
    datacontenttype: 'application/json', data: { batchId: `urn:rezics:outbox:${hash(receipt.id)}`,
      sourcePosition: { datasetId: 'product', dataEpoch: retainedEpoch, sequence },
      routingEpoch: 'retained-routing', ordinal: 0, receipt } };
  const coverage: relay.RelayCoverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'restore', dataEpoch: retainedEpoch,
    sequence, batchCount: '41', eventCount: '41', batchDigest: 'a'.repeat(64), eventDigest: 'b'.repeat(64) };
  const retained = spyOn(relay, 'relayRetainedEventAt').mockResolvedValue({ eventId, envelope,
    batch: { batchId: envelope.data.batchId, routingEpoch: envelope.data.routingEpoch, eventCount: 1 } });
  const admitted = { action: receipt.action, state: 'sealed', scope_id: receipt.scope,
    request_digest: receipt.requestDigest, authority_epoch: receipt.authorityEpoch, acting_subject: payload.decider,
    graph_receipt: receipt.id, graph_outcome: 'succeeded', graph_data_epoch: retainedEpoch, graph_sequence: sequence };
  let admissionRows = [admitted], fenceRows: { open: boolean }[] = [{ open: false }], released = 0;
  const sql: string[] = [];
  const query = async (text: string) => {
    sql.push(text);
    if (text.includes('SELECT open')) return { rows: fenceRows, rowCount: fenceRows.length };
    if (text.includes('FROM access.admission')) return { rows: admissionRows, rowCount: admissionRows.length };
    if (['BEGIN ISOLATION LEVEL REPEATABLE READ', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected Access query: ${text}`);
  };
  const pool = { connect: async () => ({ query, release: () => { released++; } }) } as unknown as Pool;
  const relayPool = { query: async () => { throw new Error('Retained relay lookup must use relayRetainedEventAt'); } } as unknown as Pool;
  return { env, fuseki, payload, receipt, admitted, sql, coverage,
    reconcile: () => reconcileRetainedClassificationDecision(env, pool, relayPool, coverage, sequence),
    fence: (value: boolean | null) => { fenceRows = value === null ? [] : [{ open: value }]; },
    admissions: (values: typeof admitted[]) => { admissionRows = values; },
    replacePayload: (change: Record<string, unknown>) => {
      receipt.decisionManifest = `urn:rezics:sha256:${prepareComponent(directory, payload.application,
        { ...payload, ...change }, CLASSIFICATION_DIRECT_DECISION_PROFILE)}`;
    },
    get released() { return released; },
    objects: () => readdirSync(directory).sort(),
    stop: () => { retained.mockRestore(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const outcome of ['accepted', 'rejected'] as const) {
  test(`classification restore preserves exact retained ${outcome} meaning through native maintenance`, async () => {
    const run = fixture(outcome);
    try {
      expect(readComponentState(run.env.objectDirectory, run.receipt.decisionManifest,
        run.payload.application, CLASSIFICATION_DIRECT_DECISION_PROFILE)).toEqual(run.payload);
      expect(await run.reconcile()).toEqual({ receipt: run.receipt.id, application: run.payload.application,
        decision: run.payload.decision, replayed: false });
      expect(run.fuseki.commands).toHaveLength(1);
      const command = run.fuseki.commands[0]!;
      expect(command.receipt).toMatch(/^urn:rezics:name-migration:statement-upgrade:restore:[a-f0-9]{64}$/);
      expect(command.digest).toBe(hash(JSON.stringify(['statement-storage-restore-v1', epoch,
        routingEpoch, run.receipt.id, run.receipt.requestDigest, retainedEpoch, sequence])));
      expect(command.receipt).toBe(`${prefix}${command.digest}`);
      expect(command.deadlineMs).toBe(STATEMENT_CONVERSION_COST.deadlineMs);
      expect(command.update).toContain('rv:commandFamily "statement-upgrade-restore-v1"');
      expect(command.update).toContain('rv:restoreHold true');
      expect(command.update).toContain('rv:sequence 0');
      expect(command.update).toContain(`rv:reconciledPriorSequence ${sequence}`);
      expect(command.update).toContain(`rv:dataEpoch "${retainedEpoch}"`);
      expect(command.update).toContain('FILTER(!BOUND(?replacedHead))');
      expect(command.update).toContain('FILTER(!BOUND(?historicalHead))');
      expect(command.update).toContain(`rv:interpretationDefinition <${run.payload.senseRevision}>`);
      expect(command.update).not.toContain(`rv:head <${run.payload.senseRevision}>`);
      expect(command.update).not.toMatch(new RegExp(`<${run.payload.sense}>[^.]*rv:head`, 's'));
      const definitionRead = run.fuseki.queries.find(query => query.includes('SELECT ?manifest ?profile'))!;
      expect(definitionRead).toContain(`GRAPH <${GRAPHS.revisions}>`);
      expect(definitionRead).toContain(`<${run.payload.senseRevision}> a rv:RevisionAnchor`);
      expect(definitionRead).not.toContain(GRAPHS.current);
      expect(command.update).not.toContain('rv:sequence ?next');
      expect(command.validations.map(value => value.profile)).toEqual([
        'statement-v1', 'statement-v1', 'statement-decision-v1', 'statement-decision-v1']);
      for (const validation of command.validations) {
        expect(validation.sha256).toBe(profileRegistry[validation.profile as keyof typeof profileRegistry].sha256);
        expect(validation.graphs).toEqual([GRAPHS.current, GRAPHS.revisions]);
        expect(validation.binding).toBeUndefined();
      }
      const converted = run.fuseki.conversion!;
      const manifests = [...command.update.matchAll(/rv:manifest <(urn:rezics:sha256:[a-f0-9]{64})>/g)].map(match => match[1]!);
      const statement = readComponentState(run.env.objectDirectory, manifests[0]!, converted.statement, STATEMENT_PROFILE);
      const decision = readComponentState(run.env.objectDirectory, manifests[1]!, converted.slot, STATEMENT_DECISION_PROFILE);
      expect(statement.meaning).toEqual({ subject: run.payload.mainVersion, predicate: CLASSIFIED_AS,
        relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
        interpretationDefinitions: [run.payload.senseRevision], value: { kind: 'resource', iri: id(10) }, applicability: [] });
      expect(decision).toMatchObject({ outcome, convertedFrom: run.payload.decision,
        predecessor: null, decidedBy: run.payload.decider, support: [converted.statement] });
      expect(run.fuseki.rawUpdates).toBe(0);
      expect(run.fuseki.cursor).toBe(sequence);
      expect(run.sql.at(-1)).toBe('COMMIT');
      expect(run.released).toBe(1);
    } finally { run.stop(); }
  });
}

test('classification restore receipt selects maintenance authentication on the native command endpoint', async () => {
  const run = fixture();
  const requests: { url: string; authorization: string | null; body: string }[] = [];
  const transport = Object.assign(async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
    return Response.json({ status: 'committed', position: { datasetId: DATASET, dataEpoch: epoch, sequence: '0' } });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(transport);
  try {
    await run.reconcile();
    const command = run.fuseki.commands[0]!;
    await new FusekiClient('http://localhost/product', 'b'.repeat(64), 'c'.repeat(64)).command(command);
    expect(requests).toEqual([{ url: 'http://localhost/product/command', authorization: `Bearer ${'b'.repeat(64)}`,
      body: JSON.stringify(command) }]);
    await expect(new FusekiClient('http://localhost/product', '', 'c'.repeat(64)).command(command))
      .rejects.toThrow('maintenance capability is required');
    expect(requests).toHaveLength(1);
  } finally { fetch.mockRestore(); run.stop(); }
});

for (const fence of [null, true]) {
  test(`classification restore denies ${fence === null ? 'missing' : 'open'} Access recovery fence`, async () => {
    const run = fixture(); run.fence(fence);
    try {
      await expect(run.reconcile()).rejects.toThrow('Access recovery fence is not held');
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.fuseki.cursor).toBe('40');
      expect(run.sql.at(-1)).toBe('ROLLBACK');
      expect(run.released).toBe(1);
    } finally { run.stop(); }
  });
}

for (const field of ['authority_epoch', 'acting_subject', 'request_digest', 'state', 'graph_receipt', 'graph_sequence'] as const) {
  test(`classification restore denies retained admission ${field} mismatch`, async () => {
    const run = fixture(); run.admitted[field] = field === 'acting_subject' ? id(25) : 'mismatch';
    try {
      await expect(run.reconcile()).rejects.toThrow('current Access admission does not prove retained decision');
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.fuseki.cursor).toBe('40');
      expect(run.sql.at(-1)).toBe('ROLLBACK');
    } finally { run.stop(); }
  });
}

for (const count of [0, 2]) {
  test(`classification restore denies ${count === 0 ? 'absent' : 'duplicate'} Access admission`, async () => {
    const run = fixture(); run.admissions(count === 0 ? [] : [run.admitted, { ...run.admitted }]);
    try {
      await expect(run.reconcile()).rejects.toThrow('current Access admission does not prove retained decision');
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.fuseki.cursor).toBe('40');
    } finally { run.stop(); }
  });
}

test('classification restore checks the sealed digest against the exact retained decision input', async () => {
  const run = fixture(); run.receipt.requestDigest = 'd'.repeat(64); run.admitted.request_digest = run.receipt.requestDigest;
  try {
    await expect(run.reconcile()).rejects.toThrow('current Access admission does not prove retained decision');
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.fuseki.cursor).toBe('40');
  } finally { run.stop(); }
});

test('classification restore rejects retained payload that differs from the terminal envelope', async () => {
  const run = fixture(); run.replacePayload({ outcome: 'rejected' });
  try {
    await expect(run.reconcile()).rejects.toThrow('retained classification decision payload differs');
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.sql).toHaveLength(0);
  } finally { run.stop(); }
});

test('classification restore guards the exact local native and historical predecessor', async () => {
  const run = fixture('accepted', id(20)); run.fuseki.nativeHead = id(21);
  try {
    await run.reconcile();
    const update = run.fuseki.commands[0]!.update;
    expect(update).toContain(`rv:decisionHead <${id(21)}>`);
    expect(update).toContain(`FILTER(?replacedHead = <${id(21)}>)`);
    expect(update).toContain(`FILTER(?otherNativeHead != <${id(21)}>)`);
    expect(update).toContain(`FILTER(COALESCE(?historicalHead, ?retainedRawHead) = <${id(20)}>)`);
    expect(update).toContain(`FILTER(?otherHistoricalHead != <${id(20)}>)`);
    expect(update).toContain(`rv:expectedHead <${id(20)}>`);
    expect(update).toContain(`rv:convertedFrom <${id(20)}>`);
  } finally { run.stop(); }
});

for (const failure of ['stale', 'graph-fence', 'interrupt'] as const) {
  test(`classification restore retains cursor and rolls back on ${failure}`, async () => {
    const run = fixture();
    if (failure === 'stale') run.fuseki.staleNext = true;
    if (failure === 'graph-fence') run.fuseki.graphHeld = false;
    if (failure === 'interrupt') run.fuseki.interruptBefore = true;
    try {
      await expect(run.reconcile()).rejects.toBeInstanceOf(RetainedEffectConflict);
      expect(run.fuseki.cursor).toBe('40');
      expect(run.fuseki.terminal).toBeNull();
      expect(run.fuseki.conversion).toBeNull();
      expect(run.sql.at(-1)).toBe('ROLLBACK');
      expect(run.released).toBe(1);
      if (failure === 'interrupt') {
        const objects = run.objects();
        expect(await run.reconcile()).toMatchObject({ replayed: false });
        expect(run.fuseki.commands[1]!.receipt).toBe(run.fuseki.commands[0]!.receipt);
        expect(run.objects()).toEqual(objects);
        expect(run.fuseki.cursor).toBe(sequence);
      }
    } finally { run.stop(); }
  });
}

test('classification restore resolves an immediate lost response from committed proof', async () => {
  const run = fixture(); run.fuseki.loseResponse = true;
  try {
    expect(await run.reconcile()).toMatchObject({ replayed: false });
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.fuseki.cursor).toBe(sequence);
    expect(run.sql.at(-1)).toBe('COMMIT');
    const objects = run.objects();
    expect(await run.reconcile()).toMatchObject({ replayed: true });
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.objects()).toEqual(objects);
  } finally { run.stop(); }
});

test('classification restore replay uses saved conversion after a later shared slot head', async () => {
  const run = fixture();
  try {
    await run.reconcile();
    const objects = run.objects(), queryCount = run.fuseki.queries.length;
    const original = { ...run.fuseki.conversion! };
    run.fuseki.nativeHead = id(99); run.fuseki.cursor = '42';
    expect(await run.reconcile()).toMatchObject({ replayed: true });
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.fuseki.conversion).toEqual(original);
    expect(run.fuseki.nativeHead).toBe(id(99));
    expect(run.objects()).toEqual(objects);
    expect(run.fuseki.queries.slice(queryCount).some(query => query.includes('SELECT ?head WHERE'))).toBe(false);
  } finally { run.stop(); }
});

for (const missing of [true, false]) {
  test(`classification restore denies replay with ${missing ? 'missing' : 'corrupt'} conversion proof`, async () => {
    const run = fixture();
    try {
      await run.reconcile();
      const objects = run.objects();
      run.fuseki.missingConversion = missing; run.fuseki.denyProof = !missing;
      await expect(run.reconcile()).rejects.toBeInstanceOf(RetainedEffectConflict);
      expect(run.fuseki.commands).toHaveLength(1);
      expect(run.objects()).toEqual(objects);
      expect(run.sql.at(-1)).toBe('ROLLBACK');
    } finally { run.stop(); }
  });
}

test('offline restore modules cannot bypass the native command endpoint with raw Fuseki updates', () => {
  for (const path of ['work/restore-lineage.ts', 'work/reconcile-restored.ts',
    'protection/reconcile-restored.ts', 'source/reconcile-restored.ts']) {
    const source = readFileSync(new URL(`../src/modules/${path}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bfuseki\s*\.\s*update\s*\(/);
  }
});

/** External owner boundaries for the unit test: committed Context facts and
 * receipts survive responses, while stale guarded commands have no effects. */
class ContextRestoreFuseki extends RestoreFuseki {
  current: { context: string; revision: string; scheme: string | null; profile: string } | null = null;
  receipts = new Map<string, Record<string, string>>();
  schemes = new Map([[id(600), id(601)], [id(610), id(611)]]);
  nextSequence = 41;
  sequenceStride = 1;
  paired = false;
  mainCursor = '10';
  dropScheme = false;
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    const restoring = envelope.update.includes('rv:restoreCutover');
    const insert = envelope.update.split('INSERT {')[1]!.split('WHERE {')[0]!;
    const predecessor = insert.match(/rv:expectedHead <([^>]+)>/)?.[1] ?? null;
    const scheme = insert.match(/rv:classificationScheme <([^>]+)>/)?.[1] ?? null;
    const schemeGuard = envelope.update.match(/rv:schemeRevisionHead <([^>]+)>/)?.[1];
    if (restoring && !this.graphHeld || predecessor !== (this.current?.revision ?? null)
      || scheme && this.schemes.get(scheme) !== schemeGuard) return { status: 'guard-unmatched' };
    const sourceSequence = restoring ? insert.match(/rv:sequence (\d+)\s*\./)![1]! : String(this.nextSequence);
    if (restoring && (this.paired ? BigInt(sourceSequence) <= BigInt(this.cursor)
      : BigInt(sourceSequence) !== BigInt(this.cursor) + 1n)) return { status: 'guard-unmatched' };
    const context = field(insert, 'classificationContext'), revision = field(insert, 'contextRevision');
    this.current = { context, revision, scheme: this.dropScheme ? null : scheme, profile: field(insert, 'modelRevision') };
    this.receipts.set(envelope.receipt, { outcome: `${RV}Succeeded`, digest: envelope.digest,
      id: insert.match(/rv:admissionId "([^"]+)"/)![1]!, epoch: '3',
      scope: `classification:context:${id(500)}`, dataEpoch: retainedEpoch, sequence: sourceSequence,
      context, realm: id(500), revision, ...(scheme ? { scheme } : {}) });
    if (restoring) {
      this.cursor = sourceSequence;
      if (this.paired) this.mainCursor = insert.match(/rv:reconciledPriorMainSequence (\d+)/)![1]!;
    } else this.nextSequence += this.sequenceStride;
    if (this.loseResponse) { this.loseResponse = false; throw new CommandOutcomeUnknown('lost Context restore response'); }
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: epoch, sequence: '0' } };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('?outcome ?digest ?id')) {
      const receipt = sparql.match(/<([^>]+)> a rv:OperationReceipt/)![1]!;
      const terminal = this.receipts.get(receipt);
      return rows(terminal ? [terminal] : []);
    }
    if (sparql.includes('SELECT ?context ?head WHERE'))
      return rows([this.current ? { context: this.current.context, head: this.current.revision } : {}]);
    if (sparql.includes('SELECT ?head WHERE')) {
      const scheme = [...this.schemes].find(([value]) => sparql.includes(`<${value}>`));
      return rows(scheme ? [{ head: scheme[1] }] : []);
    }
    if (sparql.includes('SELECT ?saved ?savedMain WHERE')) return rows([{ saved: '0', ...(this.paired ? { savedMain: '10' } : {}) }]);
    if (sparql.includes('SELECT ?cursor WHERE')) return rows([{ cursor: this.cursor }]);
    if (sparql.includes('SELECT ?context ?revision ?scheme WHERE'))
      return rows(this.current ? [{ context: this.current.context, revision: this.current.revision,
        ...(this.current.scheme ? { scheme: this.current.scheme } : {}) }] : []);
    if (sparql.includes('SELECT ?space ?realmRevision ?disclosure'))
      return rows([{ space: id(501), realmRevision: id(502), disclosure: `${RV}Public` }]);
    if (sparql.includes('ASK') && sparql.includes('rv:InvalidProfile')) return { boolean: false };
    if (sparql.includes('ASK') && sparql.includes('?currentMain'))
      return { boolean: BigInt(this.mainCursor) >= BigInt(sparql.match(/currentMain >= (\d+)/)![1]!) };
    if (sparql.includes('ASK') && sparql.includes('GRAPH') && sparql.includes('rv:head <')) {
      const scheme = sparql.match(/rv:classificationScheme <([^>]+)>/)?.[1] ?? null;
      return { boolean: this.current?.revision === field(sparql, 'head') && this.current.scheme === scheme };
    }
    if (sparql.includes('ASK') && sparql.includes(`GRAPH <${GRAPHS.receipts}>`)) {
      const receipt = sparql.match(/<urn:rezics:receipt:[a-f0-9]{64}>/)![0].slice(1, -1);
      return { boolean: this.receipts.has(receipt) };
    }
    if (sparql.includes('ASK') && sparql.includes(GLOBAL_CLASSIFICATION_CONTEXT)) return { boolean: true };
    if (sparql.includes('ASK') && sparql.includes(`GRAPH <${GRAPHS.control}>`)) return { boolean: !this.graphHeld };
    throw new Error(`Unexpected Context query: ${sparql}`);
  }
}

async function contextRestoreFixture(legacy = false, paired = false) {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join('.temp', 'context-selection-restore-'));
  const fuseki = new ContextRestoreFuseki(); fuseki.graphHeld = false;
  fuseki.paired = paired; fuseki.sequenceStride = paired ? 2 : 1;
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory, lineage: { dataEpoch: epoch, routingEpoch } };
  const liveEnv = { ...env, lineage: { dataEpoch: retainedEpoch, routingEpoch: 'retained-routing' } };
  const events = new Map<string, relay.MainCloudEvent>();
  const admissions = new Map<string, Record<string, unknown>>();
  const sql: string[] = [];
  const pool = { connect: async () => ({
    query: async (text: string, args?: unknown[]) => {
      sql.push(text);
      if (text.includes('SELECT open')) return { rows: [{ open: false }] };
      if (text.includes('FROM access.admission')) return { rows: [admissions.get(String(args![0]))] };
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
      throw new Error(`Unexpected Context Access query: ${text}`);
    }, release: () => {},
  }) } as unknown as Pool;
  const relayPool = {} as Pool;
  const retained = spyOn(relay, 'relayRetainedEventAt').mockImplementation(async (_pool, _coverage, sourceSequence) => {
    const envelope = events.get(sourceSequence)!;
    return { eventId: envelope.id, envelope, batch: { batchId: envelope.data.batchId,
      routingEpoch: envelope.data.routingEpoch, eventCount: 1 } };
  });
  const emit = async (input: CreateClassificationContextInput) => {
    const admissionId = id(events.size + 700).slice(-36);
    const admission = { id: admissionId, action: 'classification.context.configure', scope: `classification:context:${id(500)}`,
      actingSubject: id(503), requestDigest: classificationContextDigest(input), authorityEpoch: '3',
      expiresAt: '2999-01-01T00:00:00Z' } as RegisteredAdmission;
    const result = await createClassificationContext(liveEnv, admission, input);
    const command = fuseki.commands.at(-1)!;
    const receipt: relay.MainCloudEvent['data']['receipt'] = { id: result.receipt, admissionId,
      requestDigest: result.requestDigest, authorityEpoch: '3', scope: admission.scope,
      action: 'classification.context.configure', outcome: 'succeeded', realm: input.realm,
      classificationContext: result.context!, contextRevision: result.revision!,
      contextManifest: field(command.update, 'manifest'), operation: field(command.update, 'operation'),
      ...(input.profile === 'classification-context-v2' && input.expectedHead ? { expectedHead: input.expectedHead } : {}) };
    const deliverySequence = paired ? String(11 + events.size) : result.sequence;
    const eventId = `urn:rezics:event:${hash(receipt.operation!)}`;
    const envelope: relay.MainCloudEvent = { specversion: '1.0', id: eventId,
      source: 'https://rezics.com/services/main', type: 'com.rezics.classification.context-created.v1',
      datacontenttype: 'application/json', data: { batchId: `urn:rezics:outbox:${hash(receipt.id)}`,
        sourcePosition: { datasetId: 'product', dataEpoch: retainedEpoch, sequence: result.sequence },
        routingEpoch: 'retained-routing', ordinal: 0, receipt,
        ...(paired ? { relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: retainedEpoch, sequence: deliverySequence } } : {}) } };
    events.set(deliverySequence, envelope);
    admissions.set(admissionId, { action: admission.action, state: 'sealed', scope_id: admission.scope,
      request_digest: receipt.requestDigest, authority_epoch: '3', acting_subject: input.actingSubject,
      graph_receipt: receipt.id, graph_outcome: 'succeeded', graph_data_epoch: retainedEpoch, graph_sequence: result.sequence });
    return { result, receipt, sourceSequence: result.sequence, deliverySequence };
  };
  const initial = await emit(legacy ? { realm: id(500), actingSubject: id(503) } : {
    profile: 'classification-context-v2', realm: id(500), actingSubject: id(503), expectedHead: null,
    scheme: { id: id(600), expectedHead: id(601) },
  });
  const input = { profile: 'classification-context-v2' as const, realm: id(500), actingSubject: id(503),
    expectedHead: initial.result.revision!, scheme: { id: id(610), expectedHead: id(611) } };
  const replaced = await emit(input);
  const cleared = await emit({ ...input, expectedHead: replaced.result.revision!, scheme: null });
  fuseki.current = null; fuseki.receipts.clear(); fuseki.graphHeld = true; fuseki.commands = [];
  const coverage: relay.RelayCoverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'restore', dataEpoch: retainedEpoch,
    sequence: cleared.deliverySequence, batchCount: paired ? '13' : '43', eventCount: paired ? '13' : '43', batchDigest: 'a'.repeat(64), eventDigest: 'b'.repeat(64) };
  return { env, fuseki, initial, replaced, cleared, input, admissions, sql,
    reconcile: (sourceSequence: string) => reconcileRetainedClassificationContext(env, pool, relayPool, coverage, sourceSequence),
    read: async () => { fuseki.graphHeld = false;
      try { return await readRealmClassificationContext(env, id(500)); } finally { fuseki.graphHeld = true; } },
    stop: () => { retained.mockRestore(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const [legacy, paired] of [[false, false], [true, false], [false, true]] as const) {
  test(`Context restore reads back ${legacy ? 'v1 compatibility and its v2 upgrade' : 'v2 selection'} with ${paired ? 'scoped' : 'legacy'} relay positions and replays replacements exactly`, async () => {
    const run = await contextRestoreFixture(legacy, paired);
    try {
      const payload = readComponentState(run.env.objectDirectory, run.initial.receipt.contextManifest!,
        run.initial.result.context!, legacy ? CLASSIFICATION_CONTEXT_PROFILE : CLASSIFICATION_CONTEXT_V2_PROFILE);
      if (!legacy) expect(payload.selectionIntent).toEqual({ expectedHead: null,
        scheme: { id: id(600), expectedHead: id(601) } });
      await run.reconcile(run.initial.deliverySequence);
      expect(await run.read()).toMatchObject({ context: run.initial.result.context,
        contextRevision: run.initial.result.revision, scheme: legacy ? null : id(600) });
      await run.reconcile(run.replaced.deliverySequence);
      expect(await run.read()).toMatchObject({ context: run.initial.result.context,
        contextRevision: run.replaced.result.revision, scheme: id(610) });
      const replacement = run.fuseki.commands[1]!;
      expect(replacement.update).toContain(`rv:predecessor <${run.initial.result.revision}>`);
      expect(replacement.validations.map(value => value.profile)).toEqual([
        'classification-context-v1', 'classification-context-v1', 'classification-context-v1',
        'classification-context-v2', 'classification-context-v2', 'classification-context-v2']);
      await run.reconcile(run.cleared.deliverySequence);
      expect(await run.read()).toMatchObject({ contextRevision: run.cleared.result.revision, scheme: null });
      expect(await run.reconcile(run.initial.deliverySequence)).toMatchObject({ replayed: true });
      expect(await run.reconcile(run.replaced.deliverySequence)).toMatchObject({ replayed: true });
      expect(run.fuseki.commands).toHaveLength(3);
      expect(await run.read()).toMatchObject({ contextRevision: run.cleared.result.revision, scheme: null });
    } finally { run.stop(); }
  });
}

for (const failure of ['stale-context', 'stale-scheme', 'unproved-admission', 'scheme-dropped', 'intent-missing', 'intent-tampered'] as const) {
  test(`Context restore refuses ${failure} without silently selecting another scheme`, async () => {
    const run = await contextRestoreFixture();
    try {
      await run.reconcile(run.initial.deliverySequence);
      if (failure === 'stale-context') run.fuseki.current!.revision = id(999);
      if (failure === 'stale-scheme') run.fuseki.schemes.set(id(610), id(999));
      if (failure === 'unproved-admission') run.admissions.get(run.replaced.receipt.admissionId)!.request_digest = '0'.repeat(64);
      if (failure === 'scheme-dropped') run.fuseki.dropScheme = true;
      if (failure === 'intent-missing') run.replaced.receipt.contextManifest = `urn:rezics:sha256:${prepareComponent(
        run.env.objectDirectory, run.replaced.result.context!, { realm: id(500), role: 'realm-classification', state: 'active',
          fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT, inheritancePolicy: CLASSIFICATION_INHERIT_POLICY,
          scheme: id(610) }, CLASSIFICATION_CONTEXT_V2_PROFILE)}`;
      if (failure === 'intent-tampered') run.replaced.receipt.contextManifest = `urn:rezics:sha256:${prepareComponent(
        run.env.objectDirectory, run.replaced.result.context!, { realm: id(500), role: 'realm-classification', state: 'active',
          fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT, inheritancePolicy: CLASSIFICATION_INHERIT_POLICY,
          scheme: id(610), selectionIntent: { expectedHead: run.initial.result.revision,
            scheme: { id: id(610), expectedHead: id(999) } } }, CLASSIFICATION_CONTEXT_V2_PROFILE)}`;
      await expect(run.reconcile(run.replaced.deliverySequence)).rejects.toBeInstanceOf(RetainedEffectConflict);
      expect(run.sql.at(-1)).toBe(failure === 'intent-missing' ? 'COMMIT' : 'ROLLBACK');
      if (failure !== 'scheme-dropped') {
        expect(run.fuseki.cursor).toBe(run.initial.deliverySequence);
        expect(run.fuseki.receipts.has(run.replaced.receipt.id)).toBe(false);
      }
    } finally { run.stop(); }
  });
}


test('Context restore resolves a lost replacement response without changing its retained selection', async () => {
  const run = await contextRestoreFixture();
  try {
    await run.reconcile(run.initial.deliverySequence);
    run.fuseki.loseResponse = true;
    expect(await run.reconcile(run.replaced.deliverySequence)).toMatchObject({ replayed: false });
    expect(await run.read()).toMatchObject({ contextRevision: run.replaced.result.revision, scheme: id(610) });
    expect(await run.reconcile(run.replaced.deliverySequence)).toMatchObject({ replayed: true });
    expect(run.fuseki.commands).toHaveLength(2);
  } finally { run.stop(); }
});

/** External graph boundary for the real cancellation writer, relay reader and
 * restore owner; record only native effects, including the literal reason. */
class ContextCancellationFuseki extends ContextRestoreFuseki {
  outbox: { batchId: string; eventId: string; receipt: string; streamSequence?: string } | null = null;
  dropReason = false;
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    if (!envelope.update.includes('a rv:ClassificationContextCancelledEvent')) return super.commandWithReceipt(envelope);
    this.commands.push(envelope);
    const restoring = envelope.update.includes('rv:restoreCutover');
    const insert = envelope.update.split('INSERT {')[1]!.split('WHERE {')[0]!;
    const sourceSequence = restoring ? insert.match(/rv:sequence (\d+)\s*\./)![1]! : String(this.nextSequence);
    const streamSequence = insert.match(/rv:streamSequence (\d+)/)?.[1];
    if (this.receipts.has(envelope.receipt) || restoring && (!this.graphHeld
      || (this.paired ? BigInt(sourceSequence) <= BigInt(this.cursor)
        || streamSequence !== String(BigInt(this.mainCursor) + 1n)
        : sourceSequence !== String(BigInt(this.cursor) + 1n)))) return { status: 'guard-unmatched' };
    const literal = (predicate: string) => insert.match(new RegExp(`rv:${predicate} "([^"]*)"`))![1]!;
    const reason = insert.match(/rv:reason "([^"]*)"/)?.[1];
    this.receipts.set(envelope.receipt, { outcome: `${RV}Cancelled`, digest: envelope.digest,
      id: literal('admissionId'), epoch: literal('authorityEpoch'), scope: literal('admittedScope'),
      dataEpoch: literal('dataEpoch'), sequence: sourceSequence,
      ...(reason !== undefined && !this.dropReason ? { reason } : {}) });
    this.outbox = { batchId: insert.match(/<([^>]+)> a rv:OutboxBatch/)![1]!,
      eventId: insert.match(/<([^>]+)> a rv:ClassificationContextCancelledEvent/)![1]!,
      receipt: envelope.receipt, ...(streamSequence ? { streamSequence } : {}) };
    if (restoring) {
      this.cursor = sourceSequence;
      if (this.paired) this.mainCursor = insert.match(/rv:reconciledPriorMainSequence (\d+)/)![1]!;
    } else this.nextSequence++;
    if (this.loseResponse) { this.loseResponse = false; throw new CommandOutcomeUnknown('lost cancellation response'); }
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: epoch, sequence: '0' } };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('?kind ?ordinal ?action ?receipt')) {
      const terminal = this.outbox && this.receipts.get(this.outbox.receipt);
      if (!terminal) return rows([]);
      const result = rows([{ kind: `${RV}ClassificationContextCancelledEvent`, ordinal: '0',
        action: 'classification.context.configure', receipt: this.outbox!.receipt,
        admissionId: terminal.id!, digest: terminal.digest!, authorityEpoch: terminal.epoch!,
        scope: terminal.scope!, outcome: terminal.outcome!, epoch: terminal.dataEpoch!, sequence: terminal.sequence!,
        ...(terminal.reason !== undefined ? { reason: terminal.reason } : {}) }]);
      if (result.results!.bindings[0]!.reason) Object.assign(result.results!.bindings[0]!.reason!, {
        type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#string' });
      return result;
    }
    if (sparql.includes('SELECT ?saved ?savedMain WHERE'))
      return rows([{ saved: '40', ...(this.paired ? { savedMain: '10' } : {}) }]);
    if (sparql.includes('ASK') && sparql.includes(`GRAPH <${GRAPHS.outbox}>`)) {
      return { boolean: !!this.outbox && sparql.includes(`<${this.outbox.eventId}>`)
        && (!this.paired || sparql.includes(`rv:streamSequence ${this.outbox.streamSequence} .`)) };
    }
    return super.query(sparql);
  }
}

async function cancellationRestoreFixture(reason?: 'stale-head' | 'scheme-unavailable', paired = false) {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join('.temp', 'context-cancellation-restore-'));
  const fuseki = new ContextCancellationFuseki(); fuseki.graphHeld = false; fuseki.paired = paired;
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory, lineage: { dataEpoch: epoch, routingEpoch } };
  const admission = { id: id(900).slice(-36), action: 'classification.context.configure', scope: `classification:context:${id(500)}`,
    actingSubject: id(503), requestDigest: 'a'.repeat(64), authorityEpoch: '3', expiresAt: '2999-01-01T00:00:00Z' } as RegisteredAdmission;
  const result = await sealClassificationContextAdmission({ ...env, lineage: { dataEpoch: retainedEpoch,
    routingEpoch: 'retained-routing' } }, admission, reason);
  const outbox = fuseki.outbox!;
  const deliverySequence = paired ? '11' : result.sequence;
  const batch: relay.MainOutboxBatch = { streamScope: MAIN_RELAY_STREAM_SCOPE, batchId: outbox.batchId,
    dataEpoch: retainedEpoch, routingEpoch: 'retained-routing', graphSequence: result.sequence,
    sequence: deliverySequence, eventIds: [outbox.eventId] };
  const envelope = await relay.readMainOutboxEnvelope(fuseki, batch, outbox.eventId) as relay.MainCloudEvent;
  const retained = spyOn(relay, 'relayRetainedEventAt').mockResolvedValue({ eventId: outbox.eventId, envelope,
    batch: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, eventCount: 1 } });
  const admitted = { action: admission.action, state: 'sealed', scope_id: admission.scope,
    request_digest: result.requestDigest, authority_epoch: '3', graph_receipt: result.receipt,
    graph_outcome: 'cancelled', graph_data_epoch: retainedEpoch, graph_sequence: result.sequence };
  const sql: string[] = [];
  const pool = { connect: async () => ({ query: async (text: string) => {
    sql.push(text);
    if (text.includes('SELECT open')) return { rows: [{ open: false }] };
    if (text.includes('FROM access.admission')) return { rows: [admitted] };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
    throw new Error(`unexpected cancellation Access query: ${text}`);
  }, release() {} }) } as unknown as Pool;
  fuseki.receipts.clear(); fuseki.outbox = null; fuseki.commands = []; fuseki.graphHeld = true;
  const coverage: relay.RelayCoverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'restore', dataEpoch: retainedEpoch,
    sequence: deliverySequence, batchCount: deliverySequence, eventCount: deliverySequence,
    batchDigest: 'a'.repeat(64), eventDigest: 'b'.repeat(64) };
  return { env, fuseki, result, envelope, admitted, sql, batch,
    reconcile: () => reconcileRetainedAdmissionCancellation(env, pool, {} as Pool, coverage, deliverySequence),
    read: () => readClassificationContextReceipt(env, admission.id),
    stop: () => { retained.mockRestore(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const reason of [undefined, 'stale-head', 'scheme-unavailable'] as const) for (const paired of [false, true]) {
  test(`writer-sealed Context ${reason ?? 'v1 cancellation'} restores and replays its exact reason (${paired ? 'separate' : 'legacy'} positions)`, async () => {
    const f = await cancellationRestoreFixture(reason, paired);
    try {
      expect(f.envelope.data.receipt.reason).toBe(reason);
      f.fuseki.loseResponse = true;
      expect(await f.reconcile()).toEqual({ receipt: f.result.receipt, replayed: false, ...(reason ? { reason } : {}) });
      expect((await f.read())?.reason).toBe(reason);
      expect(f.fuseki.cursor).toBe('41');
      if (paired) expect(f.fuseki.mainCursor).toBe('11');
      expect(f.fuseki.current).toBeNull();
      const restored = await relay.readMainOutboxEnvelope(f.fuseki, f.batch, f.batch.eventIds[0]!);
      expect(restored).toEqual(f.envelope);
      expect(await f.reconcile()).toEqual({ receipt: f.result.receipt, replayed: true, ...(reason ? { reason } : {}) });
      expect(f.fuseki.commands).toHaveLength(1);
      if (reason) expect(f.fuseki.commands[0]!.update).toContain(`rv:reason "${reason}"`);
      else expect(f.fuseki.commands[0]!.update).not.toContain('rv:reason');
      if (paired) {
        f.fuseki.mainCursor = '10';
        await expect(f.reconcile()).rejects.toBeInstanceOf(RetainedEffectConflict);
      }
    } finally { f.stop(); }
  });
}

test('Context cancellation restore refuses unknown reasons, mismatched receipts and positions before writing', async () => {
  for (const change of ['unknown', 'empty', 'non-string', 'identity', 'scope', 'mixed', 'delivery', 'source', 'Access'] as const) {
    const f = await cancellationRestoreFixture('stale-head', true);
    try {
      if (change === 'unknown') Object.assign(f.envelope.data.receipt, { reason: 'unknown' });
      if (change === 'empty') Object.assign(f.envelope.data.receipt, { reason: '' });
      if (change === 'non-string') Object.assign(f.envelope.data.receipt, { reason: { reason: 'stale-head' } });
      if (change === 'identity') f.envelope.data.receipt.id = 'urn:rezics:receipt:wrong';
      if (change === 'scope') f.envelope.data.receipt.scope = 'work:create';
      if (change === 'mixed') f.envelope.data.receipt.expectedHead = id(99);
      if (change === 'delivery') f.envelope.data.relayPosition!.sequence = '12';
      if (change === 'source') f.envelope.data.sourcePosition.sequence = '0';
      if (change === 'Access') f.admitted.graph_sequence = '11';
      await expect(f.reconcile()).rejects.toBeInstanceOf(RetainedEffectConflict);
      expect(f.fuseki.commands).toHaveLength(0);
      expect(f.fuseki.receipts.size).toBe(0);
    } finally { f.stop(); }
  }
});

test('Context cancellation replay refuses a changed or dropped retained reason', async () => {
  for (const dropped of [false, true]) {
    const f = await cancellationRestoreFixture('scheme-unavailable');
    try {
      if (dropped) f.fuseki.dropReason = true;
      else { await f.reconcile(); f.envelope.data.receipt.reason = 'stale-head'; }
      await expect(f.reconcile()).rejects.toBeInstanceOf(RetainedEffectConflict);
      expect(f.fuseki.commands).toHaveLength(1);
      expect(f.sql.at(-1)).toBe('ROLLBACK');
    } finally { f.stop(); }
  }
});
