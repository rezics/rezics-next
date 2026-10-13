/** Application answers, shared by outcome records and the interactive persona probe. */
export const answerPersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type AnswerPersona = typeof answerPersonas[number];
export interface AnswerCall {
  operationId: string;
  method: string;
  /** Service-relative path, including the query exactly as requested. */
  path: string;
  body?: unknown;
}
export interface RecordedAnswer extends AnswerCall {
  status: number;
  answer: unknown;
  headers: Record<string, string>;
}
export interface AnswerSample extends RecordedAnswer { label: string }
export interface AnswerRecord {
  version: 1;
  row: string;
  personas: Record<AnswerPersona, AnswerSample[]>;
}

export const clientResponseHeaders = ['content-type', 'location', 'retry-after', 'etag', 'cache-control'] as const;
const credentialKey = /^(?:authorization|bearer|cookies?|setcookie|xsessionkey|sessionkey|sessiontoken|accesstoken|refreshtoken|idtoken|password|clientsecret|apikey|credentials?|idempotencykey|idempotencysecret)$/;
function secretKey(key: string): boolean {
  return credentialKey.test(key.toLowerCase().replace(/[-_\s]/g, ''));
}

/** Remove secrets without rewriting resource IDs, times or opaque continuations. */
export function redactAnswer(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, '[redacted]')
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (field, separator: string, key: string) => {
      try { return secretKey(decodeURIComponent(key)) ? `${separator}redacted` : field; }
      catch { return field; }
    })
    .replace(/\b(?:authorization|(?:set-)?cookie|x-session-key|session[-_]?key|idempotency[-_]?key|idempotency[-_]?secret)\s*[:=]\s*[^\r\n]*/gi, '[redacted]');
  if (Array.isArray(value)) return value.map(redactAnswer);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretKey(key)).map(([key, field]) => [key, redactAnswer(field)]));
  return value;
}

export function recordAnswer(call: RecordedAnswer): RecordedAnswer {
  const headers = Object.fromEntries(Object.entries(call.headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .filter(([key]) => clientResponseHeaders.some(header => header === key)));
  return redactAnswer({ operationId: call.operationId, method: call.method, path: call.path,
    ...(Object.hasOwn(call, 'body') ? { body: call.body } : {}), status: call.status,
    answer: call.answer, headers }) as RecordedAnswer;
}

export function answerRecord(row: string, personas: Record<AnswerPersona, AnswerSample[]>): AnswerRecord {
  return { version: 1, row, personas: Object.fromEntries(answerPersonas.map(persona => [persona,
    personas[persona].map(sample => ({ label: sample.label, ...recordAnswer(sample) })),
  ])) as AnswerRecord['personas'] };
}
