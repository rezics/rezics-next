import { AsyncLocalStorage } from 'node:async_hooks';

/** One public-search route shares a wall deadline and Fuseki call/response budget. */
export interface FusekiReadBudget { signal: AbortSignal; callsLeft: number; bytesLeft: number }
export const fusekiReadBudget = new AsyncLocalStorage<FusekiReadBudget>();

export class FusekiReadBudgetExceeded extends Error {}

function takeReadCall(): void {
  const budget = fusekiReadBudget.getStore();
  if (!budget) return;
  if (budget.callsLeft <= 0) throw new FusekiReadBudgetExceeded('Fuseki read call budget exceeded');
  budget.callsLeft--;
}

function takeReadBytes(bytes: number): void {
  const budget = fusekiReadBudget.getStore();
  if (!budget) return;
  if (bytes > budget.bytesLeft) throw new FusekiReadBudgetExceeded('Fuseki read byte budget exceeded');
  budget.bytesLeft -= bytes;
}

function readSignal(preparationSignal?: AbortSignal): AbortSignal {
  const request = fusekiReadBudget.getStore()?.signal;
  // Offline preparation shares one caller-owned finite deadline across all reads.
  // A configured client inside HTTP still obeys the tighter interactive budget.
  if (!request && preparationSignal) return preparationSignal;
  const upstream = AbortSignal.timeout(10_000);
  return AbortSignal.any([upstream, ...(request ? [request] : []),
    ...(preparationSignal ? [preparationSignal] : [])]);
}

export interface SparqlResult {
  boolean?: boolean;
  results?: { bindings: Record<string, { type: string; value: string;
    datatype?: string; 'xml:lang'?: string }>[] };
}

/** Input RDF terms retain their identity; no SPARQL literal escaping at callers. */
export type TemplateTerm = { type: 'uri'; value: string }
  | { type: 'literal'; value: string; datatype?: string; language?: string };
export interface TemplateQueryEnvelope {
  /** Only authored, reviewed template text; never a public request field. */
  query: string;
  bindings: Record<string, TemplateTerm>;
  /** Server-owned tuples replace matching empty VALUES blocks in the parsed query. */
  tables: { columns: string[]; rows: TemplateTerm[][] }[];
  /** Point qualifications bind candidate/head terms before native planning. */
  candidates?: Record<string,TemplateTerm>[];
  /** One page plus its lookahead row. Physical candidate work is qualified separately. */
  limit: number;
}

export interface CommandValidation {
  profile: string;
  sha256: string;
  shape: string;
  focus: string[];
  graphs: string[];
  binding?: Record<string, string>;
}

export interface CommandEnvelope {
  receipt: string;
  digest: string;
  update: string;
  validations: CommandValidation[];
  deadlineMs: number;
  titleAdmission?: { payload: string; signature: string };
}

export interface CommandPosition { datasetId: string; dataEpoch: string; sequence: string }
export interface TemplateIndexKey { graph: string; predicate: string; anchor: string; type: string }
export interface TemplateIndexDelta {
  position: { dataEpoch: string; sequence: string };
  entities?: { graph: string; id: string; terms: Record<string,string[]> }[];
  bases: (TemplateIndexKey & { sequence: string;previous?:string })[];
  next?: string;
}
export interface CatalogueBulkEnvelope extends CommandEnvelope {
  /** A normal guarded cancellation, sharing the item's receipt identity. */
  cancellation: string;
}
export type CommandResult =
  | { status: 'committed'; position: CommandPosition; templateIndex?: TemplateIndexDelta }
  | { status: 'guard-unmatched' | 'conflict' | 'unknown-profile' | 'deadline' }
  | { status: 'invalid'; report?: unknown };
export interface MembershipPreparationInput {
  dataEpoch: string;
  routingEpoch: string;
  /** Exact request identity survives a lost acknowledgment. */
  requestId: string;
  /** Absolute wall deadline, shared by every preparation turn and retry. */
  deadline: number;
}
export type MembershipPreparationResult =
  | { status: 'committed'; complete: boolean; placements: number; receipts: string[];
      examined: number; phase: number; after: string; restarted: boolean }
  | Exclude<CommandResult, { status: 'committed' }>;
export interface CommandHealth { moduleVersion: string; instanceId: string;
  publicSearchWriteEpoch: string; publicSearchWriteActive: boolean;
  privateSearchWriteEpoch?: string; privateSearchWriteActive?: boolean;
  publicSearchDeltaAvailable?: boolean;
  profiles: Record<string, string> }

export interface SearchDeltaProof {
  available: boolean;
  ordinal?: string; dataEpoch?: string; sequence?: string; generation?: string;
  writeEpoch?: string; luceneGeneration?: string;
  /** Startup/rebuild qualification maintained by the native delta writer. */
  qualifiedPopulation?: string;
  deltas?: { ordinal: string; dataEpoch: string; sequence: string; generation: string;
    writeEpoch: string; changes: { unit: string; before: boolean; after: boolean }[] }[];
}

export class CommandOutcomeUnknown extends Error {}
export class CommandForbidden extends Error {}
export class FusekiQueryResponseTooLarge extends Error {}

async function boundedJson<T>(response: Response, maxResponseBytes?: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) await response.body?.cancel(signal.reason);
  signal?.throwIfAborted();
  if (!signal && maxResponseBytes === undefined && !fusekiReadBudget.getStore()) return response.json() as Promise<T>;
  const limit = maxResponseBytes ?? (fusekiReadBudget.getStore() ? 1_048_576 : Infinity);
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    await response.body?.cancel();
    throw new FusekiQueryResponseTooLarge('Fuseki response exceeds byte budget');
  }
  if (!response.body) throw new Error('Fuseki response body is missing');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      takeReadBytes(next.value.byteLength);
      if (bytes > limit) throw new FusekiQueryResponseTooLarge('Fuseki response exceeds byte budget');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
export class CommandRejected extends Error {
  constructor(readonly result: Exclude<CommandResult, { status: 'committed' }>) {
    super(`Fuseki command ${result.status}`);
  }
}

const RECEIPTS = 'urn:rezics:graph:receipts';
const RV = 'https://rezics.com/vocab/';
const MAINTENANCE_RECEIPTS = [
  'urn:rezics:name-migration:',
  'urn:rezics:receipt:bootstrap:', 'urn:rezics:receipt:restore-cutover:',
  'urn:rezics:receipt:restore-release:', 'urn:rezics:receipt:retained-zero:',
  'urn:rezics:receipt:content-rebuild:', 'urn:rezics:receipt:chapter-search-index:',
  'urn:rezics:receipt:catalogue-search-index:',
] as const;

function safeIri(value: string): string {
  if (!/^(https?:\/\/[^<>\s"{}|\\^`]+|urn:[A-Za-z0-9][A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid command receipt IRI');
  }
  return `<${value}>`;
}

export class FusekiClient {
  private templateIndexWriter?: (delta: TemplateIndexDelta) => Promise<void>;
  attachTemplateIndexWriter(writer: (delta: TemplateIndexDelta) => Promise<void>): void {
    this.templateIndexWriter = writer;
  }
  private readonly baseUrl: URL;
  private readonly maintenanceCapability: string | undefined;

  constructor(baseUrl: string, maintenanceCapability = process.env.FUSEKI_MAINTENANCE_TOKEN,
    private readonly commandCapability = process.env.FUSEKI_COMMAND_TOKEN,
    private readonly preparationSignal?: AbortSignal) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Fuseki URL must be HTTP(S)');
    }
    parsed.pathname = parsed.pathname.replace(/\/*$/, '/');
    this.baseUrl = parsed;
    this.maintenanceCapability = maintenanceCapability;
  }

  async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    if (maxResponseBytes !== undefined
      && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)) {
      throw new Error('invalid Fuseki query response budget');
    }
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    takeReadCall();
    const response = await fetch(new URL('query', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      },
      body: sparql,
      signal,
    });
    if (!response.ok) throw new Error(`Fuseki query returned ${response.status}`);
    return boundedJson<SparqlResult>(response, maxResponseBytes, signal);
  }

  async templateQuery(envelope: TemplateQueryEnvelope, maxResponseBytes = 512 * 1024): Promise<SparqlResult> {
    if (!Number.isSafeInteger(envelope.limit) || envelope.limit < 1 || envelope.limit > 256
      || Object.keys(envelope.bindings).length > 64 || envelope.tables.length > 4
      || envelope.tables.reduce((total, table) => total + table.rows.length, 0) > 256
      || (envelope.candidates?.length ?? 0)>256
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 512 * 1024) {
      throw new Error('invalid template query budget');
    }
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki template query capability is required');
    }
    const body = JSON.stringify({ templateQuery: envelope });
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('template query exceeds request byte budget');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    takeReadCall();
    const response = await fetch(new URL('command', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json',
        accept: 'application/sparql-results+json', authorization: `Bearer ${this.commandCapability}` },
      body, signal,
    });
    if (response.status === 403) throw new CommandForbidden('Fuseki template query capability rejected');
    if (!response.ok) throw new Error(`Fuseki template query returned ${response.status}`);
    return boundedJson<SparqlResult>(response, maxResponseBytes, signal);
  }

  async templateIndex(input: { operation: 'basis'; keys: TemplateIndexKey[] }
    | { operation: 'backfill'; phase: number; after: string }): Promise<TemplateIndexDelta> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) throw new Error('Template index capability is required');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    takeReadCall();
    const response = await fetch(new URL('command',this.baseUrl), {
      method: 'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${this.commandCapability}` },
      body: JSON.stringify({ templateIndex: input }), signal,
    });
    if (!response.ok) throw new Error(`Template index returned ${response.status}`);
    return boundedJson<TemplateIndexDelta>(response,1024*1024, signal);
  }

  async membershipPreparationStatus(): Promise<{ needsPreparation: boolean }> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) throw new Error('Membership preparation capability is required');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    takeReadCall();
    const response = await fetch(new URL('command', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.commandCapability}` },
      body: JSON.stringify({ templateIndex: { operation: 'membership-status' } }), signal,
    });
    if (response.status === 403) throw new CommandForbidden('Membership preparation capability rejected');
    if (!response.ok) throw new Error(`Membership preparation status returned ${response.status}`);
    const result = await boundedJson<{ needsPreparation: boolean }>(response, 4096, signal);
    if (typeof result?.needsPreparation !== 'boolean') throw new Error('Malformed membership preparation status');
    return result;
  }

  async membershipPrepare(input: MembershipPreparationInput, signal?: AbortSignal): Promise<MembershipPreparationResult> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) throw new Error('Membership preparation capability is required');
    if (!input.dataEpoch || !input.routingEpoch || !input.requestId
      || !Number.isSafeInteger(input.deadline) || input.deadline < 1) throw new Error('Invalid membership preparation input');
    const remaining = Math.max(0, input.deadline - Date.now());
    const deadlineSignal = AbortSignal.timeout(remaining);
    const requestSignal = AbortSignal.any([deadlineSignal, ...(signal ? [signal] : []),
      ...(this.preparationSignal || fusekiReadBudget.getStore() ? [readSignal(this.preparationSignal)] : [])]);
    const body = JSON.stringify({ templateIndex: { operation: 'membership-prepare', ...input } });
    for (let attempt = 0; attempt < 2; attempt++) {
      requestSignal.throwIfAborted();
      try {
        takeReadCall();
        let response: Response;
        try {
          response = await fetch(new URL('command', this.baseUrl), {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.commandCapability}` },
            body, signal: requestSignal,
          });
        } catch (error) {
          requestSignal.throwIfAborted();
          throw new CommandOutcomeUnknown('Membership preparation transport outcome unknown', { cause: error });
        }
        if (response.status === 403) throw new CommandForbidden('Membership preparation capability rejected');
        if (response.status >= 500) {
          await response.body?.cancel();
          throw new CommandOutcomeUnknown(`Membership preparation returned ${response.status}`);
        }
        if (!response.ok && response.status !== 409 && response.status !== 422) {
          await response.body?.cancel();
          throw new Error(`Membership preparation returned ${response.status}`);
        }
        let result: MembershipPreparationResult;
        try { result = await boundedJson<MembershipPreparationResult>(response, 65_536, requestSignal); }
        catch (error) {
          requestSignal.throwIfAborted();
          if (error instanceof FusekiQueryResponseTooLarge || error instanceof FusekiReadBudgetExceeded) throw error;
          throw new CommandOutcomeUnknown('Membership preparation response incomplete', { cause: error });
        }
        if (!result || !['committed', 'guard-unmatched', 'conflict', 'invalid', 'unknown-profile', 'deadline'].includes(result.status)) {
          throw new Error('Malformed membership preparation result');
        }
        if (result.status === 'committed' && (typeof result.complete !== 'boolean'
          || !Number.isInteger(result.placements) || result.placements < 0 || result.placements > 24
          || !Number.isInteger(result.examined) || result.examined < 0 || result.examined > 256
          || !Array.isArray(result.receipts) || result.receipts.length !== (result.placements > 0 ? 1 : 0)
          || result.receipts.some(receipt => typeof receipt !== 'string')
          || !Number.isInteger(result.phase) || result.phase < 0 || result.phase > 4
          || result.complete !== (result.phase === 4) || result.examined < result.placements
          || typeof result.after !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(result.after)
          || typeof result.restarted !== 'boolean')) throw new Error('Malformed membership preparation bounds');
        return result;
      } catch (error) {
        if (!(error instanceof CommandOutcomeUnknown) || attempt !== 0) throw error;
      }
    }
    throw new CommandOutcomeUnknown('Membership preparation outcome unknown');
  }

  /** Legacy write surface; remaining domain and recovery adapters must migrate before P0.2 exit. */
  async update(sparql: string): Promise<void> {
    const response = await fetch(new URL('update', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/sparql-update' },
      body: sparql, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fuseki update returned ${response.status}`);
  }

  async commandHealth(): Promise<CommandHealth> {
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    takeReadCall();
    const response = await fetch(new URL('command', this.baseUrl), {
      headers: { accept: 'application/json' }, signal,
    });
    if (!response.ok) throw new Error(`Fuseki command health returned ${response.status}`);
    const value = await boundedJson<CommandHealth>(response, 65_536, signal);
    if (!value || typeof value.moduleVersion !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.instanceId)
      || !/^(0|[1-9][0-9]*)$/.test(value.publicSearchWriteEpoch)
      || typeof value.publicSearchWriteActive !== 'boolean'
      || value.publicSearchWriteActive !== (BigInt(value.publicSearchWriteEpoch) % 2n === 1n)
      || (value.publicSearchDeltaAvailable !== undefined
        && typeof value.publicSearchDeltaAvailable !== 'boolean')
      || !value.profiles
      || typeof value.profiles !== 'object') throw new Error('malformed Fuseki command health');
    return value;
  }

  async searchDeltaSince(ordinal: string): Promise<SearchDeltaProof> {
    if (!/^-1$|^(0|[1-9][0-9]*)$/.test(ordinal)) throw new Error('invalid search delta ordinal');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    takeReadCall();
    const url = new URL('command', this.baseUrl);
    url.searchParams.set('deltaSince', ordinal);
    const response = await fetch(url, {
      headers: { accept: 'application/json' }, signal,
    });
    if (!response.ok) throw new Error(`Fuseki search delta returned ${response.status}`);
    const proof = await boundedJson<SearchDeltaProof>(response, 65_536, signal);
    if (!proof || typeof proof.available !== 'boolean') throw new Error('malformed search delta proof');
    return proof;
  }

  async command(envelope: CommandEnvelope): Promise<CommandResult> {
    safeIri(envelope.receipt);
    if (!envelope.digest || !envelope.update || !Number.isSafeInteger(envelope.deadlineMs)
      || envelope.deadlineMs < 1 || envelope.deadlineMs > 60_000) {
      throw new Error('invalid Fuseki command envelope');
    }
    const maintenance = MAINTENANCE_RECEIPTS.some(prefix => envelope.receipt.startsWith(prefix));
    if (maintenance && !this.maintenanceCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki maintenance capability is required');
    }
    const capability = maintenance ? this.maintenanceCapability : this.commandCapability;
    if (capability && !/^[0-9a-f]{64}$/.test(capability)) {
      throw new Error('invalid Fuseki command capability');
    }
    let response: Response;
    try {
      response = await fetch(new URL('command', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json',
          ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(envelope.deadlineMs + 2_000),
      });
    } catch (error) {
      throw new CommandOutcomeUnknown('Fuseki command transport outcome unknown', { cause: error });
    }
    if (response.status === 403) throw new CommandForbidden('Fuseki command capability rejected');
    if (response.status >= 500) throw new CommandOutcomeUnknown(`Fuseki command returned ${response.status}`);
    if (response.status === 400) {
      const rejected = await boundedJson<{ message?: string }>(response, 4096);
      throw new Error(`Fuseki command rejected: ${rejected.message ?? 'bad request'}`);
    }
    let result: CommandResult;
    try { result = await response.json() as CommandResult; }
    catch (error) { throw new CommandOutcomeUnknown('Fuseki command response incomplete', { cause: error }); }
    if (!result || !['committed', 'guard-unmatched', 'conflict', 'invalid', 'unknown-profile', 'deadline'].includes(result.status)) {
      throw new CommandOutcomeUnknown('Fuseki command response malformed');
    }
    if (result.status === 'committed' && (!result.position || typeof result.position.datasetId !== 'string'
      || typeof result.position.dataEpoch !== 'string' || !/^\d+$/.test(result.position.sequence))) {
      throw new CommandOutcomeUnknown('Fuseki command position missing');
    }
    if (!response.ok && response.status !== 409 && response.status !== 422) {
      throw new CommandOutcomeUnknown(`Fuseki command returned ${response.status}`);
    }
    if (result.status === 'committed' && result.templateIndex && this.templateIndexWriter) {
      try { await this.templateIndexWriter(result.templateIndex); }
      catch (error) { throw new CommandOutcomeUnknown('Graph committed; template index needs receipt replay', { cause:error }); }
    }
    return result;
  }

  /** Catalogue items have independent receipts and savepoints inside one native
   * durable transaction. A lost batch response must be reconciled per receipt. */
  async catalogueBatch(items: readonly CatalogueBulkEnvelope[]): Promise<CommandResult[]> {
    if (items.length < 1 || items.length > 128 || new Set(items.map(item => item.receipt)).size !== items.length)
      throw new Error('Invalid catalogue batch');
    const body = JSON.stringify({ items });
    if (Buffer.byteLength(body) > 16_000_000) throw new Error('Catalogue batch exceeds native byte bound');
    const response = await fetch(new URL('command', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(this.commandCapability ? { authorization: `Bearer ${this.commandCapability}` } : {}) },
      body, signal: AbortSignal.timeout(35_000),
    });
    if (response.status === 403) throw new CommandForbidden('Fuseki command capability rejected');
    if (!response.ok) throw new CommandOutcomeUnknown(`Fuseki catalogue batch returned ${response.status}`);
    const result = await boundedJson<{ items: CommandResult[] }>(response, 65_536);
    if (!Array.isArray(result.items) || result.items.length !== items.length
      || result.items.some(item => !['committed', 'invalid', 'guard-unmatched', 'conflict', 'deadline', 'unknown-profile'].includes(item.status)))
      throw new CommandOutcomeUnknown('Malformed catalogue batch result');
    if (this.templateIndexWriter) for (const item of result.items) {
      if (item.status === 'committed' && item.templateIndex) await this.templateIndexWriter(item.templateIndex);
    }
    return result.items;
  }

  /** Resolve this command's receipt, never the dataset head, after an uncertain response. */
  async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    let result: CommandResult | undefined;
    try { result = await this.command(envelope); }
    catch (error) { if (!(error instanceof CommandOutcomeUnknown)) throw error; }
    if (result?.status === 'committed' || result?.status === 'invalid'
      || result?.status === 'unknown-profile') return result;
    const receipt = await this.query(`PREFIX rv: <${RV}> SELECT ?digest ?dataset ?epoch ?sequence WHERE {
      GRAPH <${RECEIPTS}> { ${safeIri(envelope.receipt)} rv:requestDigest ?digest ;
        rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    }`);
    const rows = receipt.results?.bindings ?? [];
    if (rows.length > 1) throw new Error('command receipt cardinality violation');
    if (rows.length === 1) {
      const row = rows[0]!;
      if (row.digest?.value !== envelope.digest) return { status: 'conflict' };
      if (!row.dataset || !row.epoch || !row.sequence) throw new Error('incomplete command receipt');
      if (this.templateIndexWriter) return this.command(envelope);
      return { status: 'committed', position: {
        datasetId: row.dataset.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
      } };
    }
    if (result?.status === 'deadline') {
      throw new CommandOutcomeUnknown('Fuseki command deadline; receipt absent');
    }
    if (result) return result;
    throw new CommandOutcomeUnknown('Fuseki command outcome unknown; receipt absent');
  }
}
