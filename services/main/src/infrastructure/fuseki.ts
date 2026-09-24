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
export interface CommandHealth { moduleVersion: string; profiles: Record<string, string> }

export class CommandOutcomeUnknown extends Error {}
export class CommandForbidden extends Error {}
export class FusekiQueryResponseTooLarge extends Error {}
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
    const response = await fetch(new URL('query', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      },
      body: sparql,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fuseki query returned ${response.status}`);
    if (maxResponseBytes === undefined) return response.json() as Promise<SparqlResult>;
    const length = response.headers.get('content-length');
    if (length && Number(length) > maxResponseBytes) {
      await response.body?.cancel();
      throw new FusekiQueryResponseTooLarge('Fuseki query response exceeds byte budget');
    }
    if (!response.body) throw new Error('Fuseki query response body is missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new FusekiQueryResponseTooLarge('Fuseki query response exceeds byte budget');
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as SparqlResult;
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
    const response = await fetch(new URL('command', this.baseUrl), {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fuseki command health returned ${response.status}`);
    const value = await response.json() as CommandHealth;
    if (!value || typeof value.moduleVersion !== 'string' || !value.profiles
      || typeof value.profiles !== 'object') throw new Error('malformed Fuseki command health');
    return value;
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
