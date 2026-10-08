import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CommandForbidden, CommandOutcomeUnknown, FusekiClient, type CommandEnvelope,
  type CommandHealth, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE } from '../src/modules/classification/decision.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../src/modules/classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../src/modules/classification/proposition.ts';
import { convertPopulatedStatements, prepareRetainedClassification,
  type RetainedClassification } from '../src/modules/statement/populated-conversion.ts';
import { upgradeStoredStatements } from '../src/modules/statement/upgrade.ts';
import { DATASET, GRAPHS, RV, hash, prepareComponent,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readWorkComponentState } from '../src/modules/work/history.ts';
import { CLASSIFIED_AS, STATEMENT_DECISION_PROFILE, STATEMENT_PROFILE } from '../src/modules/statement/schema.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const epoch = 'prepared-epoch', routingEpoch = 'prepared-routing', sequence = '41';
const prefix = 'urn:rezics:name-migration:statement-upgrade:';
const marker = `urn:rezics:maintenance:statement-upgrade:${hash(epoch)}`;
const node = (value: string) => ({type: 'uri',value});
const rows = (values: Record<string,string>[]): SparqlResult => ({results: {
  bindings: values.map(value => Object.fromEntries(Object.entries(value).map(([key,text]) => [key,node(text)]))) }});
const field = (text: string,predicate: string) => text.match(new RegExp(`rv:${predicate} <([^>]+)>`))?.[1];

class CommandOnlyFuseki extends FusekiClient {
  commands: CommandEnvelope[] = [];
  queries: string[] = [];
  receipts = new Map<string,CommandEnvelope>();
  held = false;
  owned = false;
  complete = false;
  priorHead: string|null = null;
  converted = new Map<string,{statement: string; revision: string; decision: string; meaningKey: string}>();
  retained: RetainedClassification[] = [];
  definitionManifest = '';
  failPhase: string|null = null;
  loseResponse: string|null = null;
  staleNextConversion = false;
  denyProof = false;
  retiredAdmission: {id: string;scope: string;requestDigest: string;authorityEpoch: string}|null = null;
  constructor() { super('http://localhost:1/product'); }
  override async update(): Promise<void> { throw new Error('raw update endpoint is unavailable'); }
  override async commandHealth(): Promise<CommandHealth> {
    return {moduleVersion: COMMAND_MODULE_VERSION,instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0',publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name,profile]) => [name,profile.sha256]))};
  }
  override async command(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    const phase = envelope.receipt.slice(prefix.length).split(':')[0]!;
    if (phase === this.failPhase) throw new CommandForbidden('maintenance denied');
    if (phase === 'convert' && this.staleNextConversion) {
      this.staleNextConversion = false;this.priorHead = id(99);return {status: 'guard-unmatched'};
    }
    this.receipts.set(envelope.receipt,envelope);
    if (phase === 'acquire') { this.held = true;this.owned = true; }
    if (phase === 'complete') this.complete = true;
    if (phase === 'release') { this.held = false;this.owned = false; }
    if (phase === 'convert') {
      const application = field(envelope.update,'convertedApplication')!;
      const statement = field(envelope.update,'statement')!;
      const revision = field(envelope.update,'statementRevision')!;
      const decision = field(envelope.update,'statementDecision')!;
      const meaningKey = field(envelope.update,'meaningKey')!;
      this.converted.set(application,{statement,revision,decision,meaningKey});
      this.priorHead = decision;
    }
    if (phase === this.loseResponse) { this.loseResponse = null;throw new CommandOutcomeUnknown('lost committed response'); }
    return {status: 'committed',position: {datasetId: DATASET,dataEpoch: epoch,sequence}};
  }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?digest ?dataset ?epoch ?sequence')) {
      const receipt = [...this.receipts].find(([iri]) => sparql.includes(`<${iri}>`));
      return rows(receipt ? [{digest: receipt[1].digest,dataset: DATASET,epoch,sequence}] : []);
    }
    if (sparql.includes('SELECT ?outcome ?reason ?digest ?id ?epoch')) {
      const admission = this.retiredAdmission;
      const sealed = this.commands.some(command => command.receipt.includes(':retire:'));
      return rows(admission && sealed ? [{outcome: `${RV}Cancelled`,reason: `${RV}Unavailable`,
        digest: admission.requestDigest,id: admission.id,epoch: admission.authorityEpoch,
        scope: admission.scope,dataEpoch: epoch,sequence}] : []);
    }
    if (sparql.includes('SELECT ?application ?head')) {
      const retained = [...this.retained].sort((a,b) => sparql.includes('?sourceSequence')
        ? Number(BigInt(a.sequence)-BigInt(b.sequence)) || a.application.localeCompare(b.application)
        : a.application.localeCompare(b.application));
      const afterSequence = sparql.match(/FILTER\(\?sourceSequence > (-?\d+)/)?.[1];
      const after = sparql.match(/STR\(\?application\)>("[^"]*")/)?.[1];
      const selected = retained.filter(value => !afterSequence || BigInt(value.sequence) > BigInt(afterSequence)
        || (value.sequence === afterSequence && value.application > (JSON.parse(after ?? '""') as string)));
      return rows(selected.slice(0,Number(sparql.match(/LIMIT (\d+)/)?.[1] ?? retained.length))
        .map(value => ({application: value.application,head: value.decision,sourceSequence: value.sequence})));
    }
    if (sparql.includes('SELECT ?main ?sense')) {
      const value = this.retained.find(value => sparql.includes(`<${value.application}> rv:targetMainVersion`))!;
      return rows([{main: value.main,sense: id(3),concept: value.concept,context: value.context,proposer: value.proposer,
        manifest: value.manifest,outcome: `${RV}${value.outcome === 'accepted' ? 'Accepted' : 'Rejected'}`,
        decidedBy: value.decidedBy,operation: value.operation,epoch: value.dataEpoch,sequence: value.sequence,
        ...(value.contextRevision ? {contextRevision: value.contextRevision} : {})}]);
    }
    if (sparql.includes('SELECT ?manifest ?profile')) return rows([{manifest: this.definitionManifest,profile: CLASSIFICATION_PROPOSITION_PROFILE}]);
    if (sparql.includes('SELECT ?head WHERE')) return rows(this.priorHead ? [{head: this.priorHead}] : []);
    if (sparql.includes('SELECT ?statement ?revision ?decision')) {
      const covered = [...this.converted].find(([application]) => sparql.includes(`<${application}>`))?.[1];
      return rows(covered ? [covered] : []);
    }
    if (sparql.includes('SELECT ?statement ?subject ?predicate')) return rows([...this.converted.values()].map(value => ({
      statement: value.statement,subject: id(2),predicate: CLASSIFIED_AS,key: value.meaningKey,head: value.revision})));
    if (sparql.includes('SELECT ?statement WHERE')) return rows([...this.converted.values()].map(value => ({statement: value.statement})));
    if (sparql.includes('SELECT ?sequence')) return rows([{sequence}]);
    if (sparql.includes(`GRAPH <${GRAPHS.receipts}>`)) {
      const exists = [...this.receipts.keys()].some(receipt => sparql.includes(`<${receipt}>`));
      return {boolean: exists && !this.denyProof};
    }
    if (sparql.includes('a rv:ClassificationApplication')) return {boolean: true};
    if (sparql.includes('rv:meaningKey') && sparql.includes('rv:head')) return {boolean: false};
    if (sparql.includes('rv:outcome rv:Succeeded')) return {boolean: this.complete && !this.held && !this.owned};
    if (sparql.includes('rv:statementUpgradeFence true')) return {boolean: this.held && this.owned};
    if (sparql.includes('rv:restoreHold true')) return {boolean: this.held};
    return {boolean: true};
  }
}

function fixture(retiredAction?: 'statement.migrate'|'statement.cutover') {
  mkdirSync('.temp',{recursive: true});
  const directory = mkdtempSync(join('.temp','statement-upgrade-test-'));
  const fuseki = new CommandOnlyFuseki();
  const sql: {text: string;values: unknown[]}[] = [];
  let accessOpen = true,coverageComplete = false,admissionSealed = false;
  let released = 0;
  const admission = {id: '00000000-0000-4000-8000-000000000100',scope_id: 'statement:retired',
    principal_id: 'operator',acting_subject: id(5),action: retiredAction,idempotency_key: 'retired-key',
    request_digest: 'd'.repeat(64),authority_epoch: '3',expires_at: new Date('2030-01-01T00:00:00Z'),state: 'registered'};
  if (retiredAction) fuseki.retiredAdmission = {id: admission.id,scope: admission.scope_id,
    requestDigest: admission.request_digest,authorityEpoch: admission.authority_epoch};
  const query = async (text: string,values: unknown[] = []) => {
    sql.push({text,values});
    if (text.includes('SELECT id,scope_id')) return {rows: retiredAction && !admissionSealed ? [admission] : [],
      rowCount: retiredAction && !admissionSealed ? 1 : 0};
    if (text.includes("UPDATE access.admission SET state='sealed'")) {admissionSealed = true;return {rows: [{id: admission.id}],rowCount: 1};}
    if (text.includes('to_regclass')) return {rows: [{present: true}],rowCount: 1};
    if (text.includes('SET open = false')) {accessOpen = false;return {rows: [{generation: '7'}],rowCount: 1};}
    if (text.includes('SET open = true')) {accessOpen = true;return {rows: [],rowCount: 1};}
    if (text.includes('SELECT open')) return {rows: [{open: accessOpen}],rowCount: 1};
    if (text.includes('SELECT through_sequence')) return {rows: [{through_sequence: sequence,complete: coverageComplete}],rowCount: 1};
    if (text.includes('SELECT 1 FROM access.statement_seek_coverage')) return {rows: [],rowCount: coverageComplete && accessOpen ? 1 : 0};
    if (text.includes('SET complete=true')) coverageComplete = true;
    if (text.includes('SET complete=false')) coverageComplete = false;
    return {rows: [],rowCount: 0};
  };
  const client = {query,release: () => {released++;}};
  const pool = {query,connect: async () => client} as unknown as Pool;
  const env: WorkActivationEnvironment = {fuseki,lineage: {dataEpoch: epoch,routingEpoch},objectDirectory: directory};
  return {env,pool,fuseki,sql,get accessOpen() {return accessOpen;},get released() {return released;},
    hold: () => {accessOpen = false;fuseki.held = true;fuseki.owned = true;},
    stop: () => rmSync(directory,{recursive: true,force: true})};
}

function retain(env: WorkActivationEnvironment,application: number,proposer: number,sourceSequence: string): RetainedClassification {
  const value = {application: id(application),decision: id(application+10),main: id(2),concept: id(4),
    context: GLOBAL_CLASSIFICATION_CONTEXT,proposer: id(proposer),decidedBy: id(5),outcome: 'accepted' as const,
    contextRevision: null,operation: id(application+20),dataEpoch: `historical-${sourceSequence}`,sequence: sourceSequence};
  const manifest = prepareComponent(env.objectDirectory,value.application,{work: id(1),mainVersion: value.main,
    application: value.application,decision: value.decision,context: value.context,proposer: value.proposer,
    decider: value.decidedBy,outcome: value.outcome,sense: id(3),senseRevision: id(6)},CLASSIFICATION_DIRECT_DECISION_PROFILE);
  return {...value,manifest: `urn:rezics:sha256:${manifest}`};
}

test('Statement upgrade reserved receipt uses maintenance authentication and command transport only', async () => {
  const requests: {url: string;authorization: string|null}[] = [];
  const transport = Object.assign(async (...[url,init]: Parameters<typeof globalThis.fetch>) => {
    requests.push({url: String(url),authorization: new Headers(init?.headers).get('authorization')});
    return Response.json({status: 'committed',position: {datasetId: DATASET,dataEpoch: epoch,sequence}});
  },{preconnect: globalThis.fetch.preconnect});
  const fetch = spyOn(globalThis,'fetch').mockImplementation(transport);
  const envelope: CommandEnvelope = {receipt: `${prefix}acquire:${'a'.repeat(64)}`,digest: 'a'.repeat(64),
    update: 'INSERT DATA {}',validations: [],deadlineMs: 1_000};
  try {
    await new FusekiClient('http://localhost/product','b'.repeat(64),'c'.repeat(64)).command(envelope);
    expect(requests).toEqual([{url: 'http://localhost/product/command',authorization: `Bearer ${'b'.repeat(64)}`}]);
    await expect(new FusekiClient('http://localhost/product','','c'.repeat(64)).command(envelope))
      .rejects.toThrow('maintenance capability is required');
    expect(requests).toHaveLength(1);
  } finally { fetch.mockRestore(); }
});

test('Statement upgrade phases preserve the dataset position and release only after rebuilt seek proof', async () => {
  const run = fixture();
  try {
    expect(await upgradeStoredStatements(run.env,run.pool)).toEqual({status: 'complete',converted: 0,replayed: 0,noop: false});
    expect(run.fuseki.commands.map(value => value.receipt.slice(prefix.length).split(':')[0])).toEqual(['acquire','complete','release']);
    for (const command of run.fuseki.commands) {
      const phase = command.receipt.slice(prefix.length).split(':')[0];
      expect(command.receipt).toMatch(/^urn:rezics:name-migration:statement-upgrade:(acquire|complete|release):[a-f0-9]{64}$/);
      expect(command.update).toContain(`rv:commandFamily "statement-upgrade-${phase}-v1"`);
      expect(command.update).toContain(`<${marker}>`);
      expect(command.update).toContain(`rv:dataEpoch "${epoch}"`);
      expect(command.update).toContain(`rv:routingEpoch "${routingEpoch}"`);
      expect(command.update).toContain('rv:sequence ?sequence');
      expect(command.update).not.toContain('rv:sequence ?next');
      expect(command.update).not.toContain(GRAPHS.outbox);
      expect(command.validations).toEqual([]);
    }
    expect(run.accessOpen).toBe(true);
    expect(run.fuseki.held).toBe(false);
    expect(run.sql.some(value => value.text.includes('SET complete=true'))).toBe(true);
    expect(run.sql.some(value => value.text.includes('pg_advisory_unlock'))).toBe(true);
    expect(await upgradeStoredStatements(run.env,run.pool)).toEqual({status: 'complete',converted: 0,replayed: 0,noop: true});
    expect(run.fuseki.commands).toHaveLength(3);
  } finally { run.stop(); }
});

test('Statement upgrade reconciles a lost acquire response with its own receipt', async () => {
  const run = fixture();run.fuseki.loseResponse = 'acquire';
  try {
    await upgradeStoredStatements(run.env,run.pool);
    expect(run.fuseki.commands.map(command => command.receipt.slice(prefix.length).split(':')[0])).toEqual(['acquire','complete','release']);
    expect(run.fuseki.queries.some(query => query.includes('SELECT ?digest ?dataset ?epoch ?sequence'))).toBe(true);
    expect(run.fuseki.held).toBe(false);
  } finally { run.stop(); }
});

test('Statement upgrade retains owned fences on failure and retry completes their release', async () => {
  const run = fixture();run.fuseki.failPhase = 'complete';
  try {
    await expect(upgradeStoredStatements(run.env,run.pool)).rejects.toBeInstanceOf(CommandForbidden);
    expect(run.accessOpen).toBe(false);
    expect(run.fuseki.held).toBe(true);
    expect(run.fuseki.owned).toBe(true);
    expect(run.sql.some(value => value.text.includes('SET open = true'))).toBe(false);
    expect(run.released).toBeGreaterThan(0);
    run.fuseki.failPhase = null;
    await upgradeStoredStatements(run.env,run.pool);
    expect(run.fuseki.commands.filter(command => command.receipt.includes(':acquire:'))).toHaveLength(1);
    expect(run.accessOpen).toBe(true);
    expect(run.fuseki.held).toBe(false);
  } finally { run.stop(); }
});

test('Statement upgrade refuses an unrelated graph fence before issuing a maintenance command', async () => {
  const run = fixture();run.fuseki.held = true;
  try {
    await expect(upgradeStoredStatements(run.env,run.pool)).rejects.toThrow('unrelated recovery fence');
    expect(run.fuseki.commands).toEqual([]);
    expect(run.sql.some(value => value.text.includes('SET open = false'))).toBe(false);
  } finally { run.stop(); }
});

test('Statement upgrade retires old admission identities through a bounded cancellation command', async () => {
  for (const action of ['statement.migrate','statement.cutover'] as const) {
    const run = fixture(action);
    try {
      await upgradeStoredStatements(run.env,run.pool);
      expect(run.fuseki.commands.map(command => command.receipt.slice(prefix.length).split(':')[0]))
        .toEqual(['retire','acquire','complete','release']);
      const retired = run.fuseki.commands[0]!;
      expect(retired.validations).toEqual([]);
      expect(retired.update).toContain('rv:commandFamily "statement-upgrade-retire-v1"');
      expect(retired.update).toContain(`rv:commandFamily "${action === 'statement.migrate' ? 'statement-migrate-v1' : 'statement-cutover-v1'}"`);
      expect(retired.update).toContain('rv:outcome rv:Cancelled');
      expect(retired.update).toContain('rv:reason rv:Unavailable');
      expect(retired.update).toContain('rv:retiredReceipt <urn:rezics:receipt:');
      const sealed = run.sql.find(query => query.text.includes("UPDATE access.admission SET state='sealed'"))!;
      expect(sealed.values.slice(2,5)).toEqual(['cancelled',epoch,sequence]);
      expect(run.sql.some(query => query.text.includes("'admission.sealed'"))).toBe(true);
    } finally { run.stop(); }
  }
});

test('Retained conversion separates speakers and preserves the original operation, epoch and sequence', async () => {
  const run = fixture();
  try {
    const first = retain(run.env,30,7,'9'),second = retain(run.env,31,8,'12');
    const a = await prepareRetainedClassification(run.env,first);
    run.fuseki.priorHead = a.decision;
    const b = await prepareRetainedClassification(run.env,second);
    expect(a.meaningKey).toBe(b.meaningKey);
    expect(a.slot).toBe(b.slot);
    expect(a.statement).not.toBe(b.statement);
    expect(b.nativePredecessor).toBe(a.decision);
    expect(a.current).toContain(`rv:speaker <${first.proposer}>`);
    expect(b.current).toContain(`rv:speaker <${second.proposer}>`);
    for (const [prepared,source] of [[a,first],[b,second]] as const) {
      expect(prepared.revisions).toContain(`rv:operation <${source.operation}>`);
      expect(prepared.revisions).toContain(`rv:dataEpoch "${source.dataEpoch}" ; rv:sequence ${source.sequence}`);
      expect(prepared.revisions).toContain(`rv:convertedFrom <${source.decision}>`);
      expect(prepared.current).toContain(`rv:interpretationDefinition <${id(6)}>`);
      expect(prepared.validations).toHaveLength(10);
      expect(prepared.validations.filter(value => value.profile === 'classification-direct-decision-v1')
        .every(value => value.binding?.proposer === source.proposer && value.binding?.decider === source.decidedBy)).toBe(true);
      const statementManifest = prepared.revisions.match(/a rv:StatementRevision[\s\S]*?rv:manifest <(urn:rezics:sha256:[a-f0-9]{64})>/)![1]!;
      const state = await readWorkComponentState(run.env,statementManifest,prepared.statement,STATEMENT_PROFILE);
      expect(state.speaker).toBe(source.proposer);
      expect(state.recordedBy).toBe(source.decidedBy);
      const decisionManifest = prepared.revisions.match(/a rv:StatementDecision[\s\S]*?rv:manifest <(urn:rezics:sha256:[a-f0-9]{64})>/)![1]!;
      const decisionState = await readWorkComponentState(run.env,decisionManifest,prepared.slot,STATEMENT_DECISION_PROFILE);
      expect(decisionState.convertedFrom).toBe(source.decision);
      expect(decisionState.support).toEqual([prepared.statement]);
    }
  } finally { run.stop(); }
});

test('Populated conversion CAS replaces a prior same-meaning context head and retries exact receipts', async () => {
  const run = fixture();run.hold();
  try {
    run.fuseki.retained = [retain(run.env,30,8,'12'),retain(run.env,31,7,'9')];
    run.fuseki.definitionManifest = `urn:rezics:sha256:${prepareComponent(run.env.objectDirectory,id(3),
      {concept: id(4)},CLASSIFICATION_PROPOSITION_PROFILE)}`;
    expect(await convertPopulatedStatements(run.env,run.pool)).toEqual({converted: 2,replayed: 0});
    const inventory = run.fuseki.queries.find(query => query.includes('SELECT ?application ?head'))!;
    expect(inventory).toContain('ORDER BY ?sourceSequence STR(?application) LIMIT 32');
    expect(inventory).toContain('AS ?sourceSequence');
    expect(inventory).toContain('DATATYPE(?retainedSequence)');
    const [first,second] = run.fuseki.commands;
    expect(field(first!.update,'convertedApplication')).toBe(id(31));
    expect(field(second!.update,'convertedApplication')).toBe(id(30));
    expect(first!.receipt).toStartWith(`${prefix}convert:`);
    expect(second!.receipt).toStartWith(`${prefix}convert:`);
    const priorHead = field(first!.update,'statementDecision')!;
    const slot = field(first!.update,'decisionSlot')!;
    expect(second!.update).toMatch(new RegExp(`DELETE \\{ GRAPH <${GRAPHS.current}> \\{\\s*<${slot}> rv:decisionHead <${priorHead}>`));
    expect(second!.update.match(new RegExp(`rv:decisionHead <${priorHead}>`,'g'))).toHaveLength(2);
    expect(second!.update).not.toContain(`FILTER NOT EXISTS { GRAPH <${GRAPHS.current}> { <${slot}> ?p ?o`);
    expect(second!.update).toContain(`rv:predecessor <${priorHead}>`);
    expect(second!.validations).toHaveLength(4);
    expect(second!.update).not.toContain('a rv:ClassificationApplication');
    const immutableObjects = readdirSync(run.env.objectDirectory).sort();
    expect(await convertPopulatedStatements(run.env,run.pool)).toEqual({converted: 0,replayed: 2});
    expect(readdirSync(run.env.objectDirectory).sort()).toEqual(immutableObjects);
    expect(run.fuseki.commands).toHaveLength(2);
    expect(run.accessOpen).toBe(false);
    expect(run.fuseki.held).toBe(true);
  } finally { run.stop(); }
});

test('Populated conversion leaves seek unavailable when a committed receipt lacks source proof', async () => {
  const run = fixture();run.hold();run.fuseki.denyProof = true;
  try {
    run.fuseki.retained = [retain(run.env,30,7,'9')];
    run.fuseki.definitionManifest = `urn:rezics:sha256:${prepareComponent(run.env.objectDirectory,id(3),
      {concept: id(4)},CLASSIFICATION_PROPOSITION_PROFILE)}`;
    await expect(convertPopulatedStatements(run.env,run.pool)).rejects.toThrow('receipt or current head is unavailable');
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.sql.some(query => query.text.includes('SET complete=true'))).toBe(false);
    expect(run.accessOpen).toBe(false);
    expect(run.fuseki.held).toBe(true);
  } finally { run.stop(); }
});

test('Populated conversion refuses a concurrently changed acceptance head and retains both fences', async () => {
  const run = fixture();run.hold();run.fuseki.priorHead = id(77);run.fuseki.staleNextConversion = true;
  try {
    run.fuseki.retained = [retain(run.env,30,7,'9')];
    run.fuseki.definitionManifest = `urn:rezics:sha256:${prepareComponent(run.env.objectDirectory,id(3),
      {concept: id(4)},CLASSIFICATION_PROPOSITION_PROFILE)}`;
    await expect(convertPopulatedStatements(run.env,run.pool)).rejects.toThrow('command guard-unmatched');
    expect(run.fuseki.commands[0]!.update.match(new RegExp(`rv:decisionHead <${id(77)}>`, 'g'))).toHaveLength(2);
    expect(run.fuseki.priorHead).toBe(id(99));
    expect(run.fuseki.receipts.size).toBe(0);
    expect(run.sql.some(query => query.text.includes('SET complete=true'))).toBe(false);
    expect(run.accessOpen).toBe(false);
    expect(run.fuseki.held).toBe(true);
  } finally { run.stop(); }
});

test('Retained conversion rejects malformed historical positions before querying or dispatching', async () => {
  const run = fixture();
  try {
    for (const sourceSequence of ['0','-1','9e0','not-a-sequence'])
      await expect(prepareRetainedClassification(run.env,retain(run.env,30,7,sourceSequence)))
        .rejects.toThrow('provenance is invalid');
    expect(run.fuseki.queries).toEqual([]);
    expect(run.fuseki.commands).toEqual([]);
  } finally { run.stop(); }
});

test('Populated conversion crosses the batch bound with an equal-sequence application keyset', async () => {
  const run = fixture();run.hold();
  try {
    run.fuseki.retained = Array.from({length: 33},(_,index) => retain(run.env,index+1000,index+2000,'9')).reverse();
    run.fuseki.definitionManifest = `urn:rezics:sha256:${prepareComponent(run.env.objectDirectory,id(3),
      {concept: id(4)},CLASSIFICATION_PROPOSITION_PROFILE)}`;
    expect(await convertPopulatedStatements(run.env,run.pool)).toEqual({converted: 33,replayed: 0});
    const pages = run.fuseki.queries.filter(query => query.includes('SELECT ?application ?head'));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain(`?sourceSequence = 9 && STR(?application)>"${id(1031)}"`);
    expect(run.fuseki.commands.map(command => field(command.update,'convertedApplication')))
      .toEqual(Array.from({length: 33},(_,index) => id(index+1000)));
    expect(run.sql.filter(query => query.text.includes('INSERT INTO access.statement_seek\n'))).toHaveLength(33);
  } finally { run.stop(); }
});
