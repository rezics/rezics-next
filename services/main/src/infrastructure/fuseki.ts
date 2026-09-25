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

function readSignal(): AbortSignal {
  const request = fusekiReadBudget.getStore()?.signal;
  const upstream = AbortSignal.timeout(10_000);
  return request ? AbortSignal.any([request, upstream]) : upstream;
}

export interface SparqlResult {
  boolean?: boolean;
  results?: { bindings: Record<string, { type: string; value: string;
    datatype?: string; 'xml:lang'?: string }>[] };
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
}

export interface CommandPosition { datasetId: string; dataEpoch: string; sequence: string }
export type CommandResult =
  | { status: 'committed'; position: CommandPosition }
  | { status: 'guard-unmatched' | 'conflict' | 'unknown-profile' | 'deadline' }
  | { status: 'invalid'; report?: unknown };
export interface CommandHealth { moduleVersion: string; instanceId: string;
  publicSearchWriteEpoch: string; publicSearchWriteActive: boolean;
  privateSearchWriteEpoch?: string; privateSearchWriteActive?: boolean;
  publicSearchDeltaAvailable?: boolean;
  profiles: Record<string, string> }

export interface SearchDeltaProof {
  available: boolean;
  ordinal?: string; dataEpoch?: string; sequence?: string; generation?: string;
  writeEpoch?: string; luceneGeneration?: string;
  deltas?: { ordinal: string; dataEpoch: string; sequence: string; generation: string;
    writeEpoch: string; changes: { unit: string; before: boolean; after: boolean }[] }[];
}

export class CommandOutcomeUnknown extends Error {}
export class CommandForbidden extends Error {}
export class FusekiQueryResponseTooLarge extends Error {}

async function boundedJson<T>(response: Response, maxResponseBytes?: number): Promise<T> {
  if (maxResponseBytes === undefined && !fusekiReadBudget.getStore()) return response.json() as Promise<T>;
  const limit = maxResponseBytes ?? 1_048_576;
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    await response.body?.cancel();
    throw new FusekiQueryResponseTooLarge('Fuseki response exceeds byte budget');
  }
  if (!response.body) throw new Error('Fuseki response body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      takeReadBytes(next.value.byteLength);
      if (bytes > limit) throw new FusekiQueryResponseTooLarge('Fuseki response exceeds byte budget');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
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
  'urn:rezics:receipt:bootstrap:', 'urn:rezics:receipt:restore-cutover:',
  'urn:rezics:receipt:restore-release:', 'urn:rezics:receipt:retained-zero:',
  'urn:rezics:receipt:content-rebuild:',
] as const;

function safeIri(value: string): string {
  if (!/^(https?:\/\/[^<>\s"{}|\\^`]+|urn:[A-Za-z0-9][A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid command receipt IRI');
  }
  return `<${value}>`;
}

export class FusekiClient {
  private readonly baseUrl: URL;
  private readonly maintenanceCapability: string | undefined;

  constructor(baseUrl: string, maintenanceCapability = process.env.FUSEKI_MAINTENANCE_TOKEN,
    private readonly commandCapability = process.env.FUSEKI_COMMAND_TOKEN) {
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
    takeReadCall();
    const response = await fetch(new URL('query', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      },
      body: sparql,
      signal: readSignal(),
    });
    if (!response.ok) throw new Error(`Fuseki query returned ${response.status}`);
    return boundedJson<SparqlResult>(response, maxResponseBytes);
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
    takeReadCall();
    const response = await fetch(new URL('command', this.baseUrl), {
      headers: { accept: 'application/json' }, signal: readSignal(),
    });
    if (!response.ok) throw new Error(`Fuseki command health returned ${response.status}`);
    const value = await boundedJson<CommandHealth>(response, 65_536);
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
    takeReadCall();
    const url = new URL('command', this.baseUrl);
    url.searchParams.set('deltaSince', ordinal);
    const response = await fetch(url, {
      headers: { accept: 'application/json' }, signal: readSignal(),
    });
    if (!response.ok) throw new Error(`Fuseki search delta returned ${response.status}`);
    const proof = await boundedJson<SearchDeltaProof>(response, 65_536);
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
    return result;
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
