import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope,
  type CommandHealth, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../src/modules/classification/context.ts';
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
import { reconcileRetainedClassificationDecision, RetainedEffectConflict } from '../src/modules/work/reconcile-restored.ts';

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
