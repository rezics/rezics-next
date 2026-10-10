/** One hidden resource and one absent id must be indistinguishable to a caller. */

export interface HiddenIdCounters {
  graphCalls: number;
  sqlStatements: number;
  bytes: number;
  mediaGenerations: number;
  rateLimitCharges: number;
}

export type HiddenIdAspect = 'status' | 'body' | 'cost' | 'sideEffects';

export class HiddenIdDifference extends Error {
  readonly operation: string;
  readonly aspect: HiddenIdAspect;

  constructor(operation: string, aspect: HiddenIdAspect, detail: string) {
    super(`${operation} answers a hidden id and an absent id differently (${aspect}): ${detail}`);
    this.name = 'HiddenIdDifference';
    this.operation = operation;
    this.aspect = aspect;
  }
}

export interface HiddenIdEqualityInput {
  operation: string;
  hiddenId: string;
  absentId: string;
  call: (id: string) => Promise<Response>;
  readCounters: () => HiddenIdCounters | Promise<HiddenIdCounters>;
}

interface Observed {
  status: number;
  body: string;
  cost: Pick<HiddenIdCounters, 'graphCalls' | 'sqlStatements' | 'bytes'>;
  sideEffects: Pick<HiddenIdCounters, 'mediaGenerations' | 'rateLimitCharges'>;
}

function delta(after: HiddenIdCounters, before: HiddenIdCounters): HiddenIdCounters {
  return {
    graphCalls: after.graphCalls - before.graphCalls,
    sqlStatements: after.sqlStatements - before.sqlStatements,
    bytes: after.bytes - before.bytes,
    mediaGenerations: after.mediaGenerations - before.mediaGenerations,
    rateLimitCharges: after.rateLimitCharges - before.rateLimitCharges,
  };
}

function stripRequestIds(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripRequestIds(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  delete record.requestId;
  for (const item of Object.values(record)) stripRequestIds(item);
}

/** The id the caller already sent, in path and IRI form. Echoing it is not a disclosure. */
function submittedIds(id: string): string[] {
  const values = [id];
  if (/^[0-9a-f-]{36}$/.test(id)) values.push(`https://rezics.com/id/${id}`);
  if (id.startsWith('https://rezics.com/id/')) values.push(id.slice('https://rezics.com/id/'.length));
  return values.filter(value => value.length > 0);
}

/** Body bytes with per-request identifiers and the submitted id removed. Key order follows the response. */
export function comparableBody(body: string, id = ''): string {
  let text = body;
  for (const value of submittedIds(id)) text = text.split(value).join('submitted-id');
  try {
    const parsed: unknown = JSON.parse(text);
    stripRequestIds(parsed);
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

function preview(value: string): string {
  return value.length > 180 ? `${value.slice(0, 180)}…` : value;
}

async function observe(
  id: string,
  call: (id: string) => Promise<Response>,
  readCounters: HiddenIdEqualityInput['readCounters'],
): Promise<Observed> {
  const before = await readCounters();
  const response = await call(id);
  const body = await response.text();
  const after = delta(await readCounters(), before);
  return {
    status: response.status,
    body: comparableBody(body, id),
    cost: { graphCalls: after.graphCalls, sqlStatements: after.sqlStatements, bytes: after.bytes },
    sideEffects: { mediaGenerations: after.mediaGenerations, rateLimitCharges: after.rateLimitCharges },
  };
}

/** Compare one hidden id with one absent id for a single operation. */
export async function assertHiddenIdEquality(input: HiddenIdEqualityInput): Promise<void> {
  const hidden = await observe(input.hiddenId, input.call, input.readCounters);
  const absent = await observe(input.absentId, input.call, input.readCounters);
  if (hidden.status !== absent.status) {
    throw new HiddenIdDifference(
      input.operation,
      'status',
      `${hidden.status} for the hidden id and ${absent.status} for the absent id`,
    );
  }
  if (hidden.body !== absent.body) {
    throw new HiddenIdDifference(
      input.operation,
      'body',
      `hidden ${preview(hidden.body)} | absent ${preview(absent.body)}`,
    );
  }
  if (JSON.stringify(hidden.cost) !== JSON.stringify(absent.cost)) {
    throw new HiddenIdDifference(
      input.operation,
      'cost',
      `hidden ${JSON.stringify(hidden.cost)} | absent ${JSON.stringify(absent.cost)}`,
    );
  }
  if (JSON.stringify(hidden.sideEffects) !== JSON.stringify(absent.sideEffects)) {
    throw new HiddenIdDifference(
      input.operation,
      'sideEffects',
      `hidden ${JSON.stringify(hidden.sideEffects)} | absent ${JSON.stringify(absent.sideEffects)}`,
    );
  }
}
