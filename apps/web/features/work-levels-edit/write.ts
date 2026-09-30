// What a write to Main answered, in the shape the edit forms show, and the idempotency key a
// write carries. Pure: the server actions call these and the tests exercise them directly.

/** What the form shows after a submit. `values` keep what was typed, so no failure loses input. */
export type WriteState =
  | { status: 'idle' }
  | { status: 'done'; receipt: string; replayed: boolean; nonce: string }
  /** Main is still applying it; sending the same form again replays the same write. */
  | { status: 'pending'; values: Values }
  /** `field` names the input that is missing or malformed when the form caught it before asking Main. */
  | { status: 'error'; problem: Problem; detail: string | null; field: string | null; values: Values };
export type Values = Readonly<Record<string, string>>;

/** The kinds of refusal a person can act on differently. */
export type Problem = 'sign-in' | 'denied' | 'stale' | 'invalid' | 'unavailable';

type ProblemAnswer = { status: number; value?: unknown };

/** The refusal a Main status means: 409 is a head that moved, 400 and 422 a rejected input, 401 and 403 no authority. */
export function problemOf(error: ProblemAnswer): { problem: Problem; detail: string | null } {
  const value = typeof error.value === 'object' && error.value !== null ? error.value as Record<string, unknown> : {};
  const detail = typeof value.detail === 'string' && value.detail ? value.detail
    : typeof value.title === 'string' && value.title ? value.title : null;
  const problem: Problem = error.status === 401 ? 'sign-in'
    : error.status === 403 || error.status === 404 ? 'denied'
      : error.status === 409 ? 'stale'
        : error.status === 400 || error.status === 413 || error.status === 422 ? 'invalid' : 'unavailable';
  return { problem, detail };
}

/** The receipt a write answered with, whichever shape the route uses. */
export function receiptOf(data: unknown): { receipt: string; replayed: boolean } | null {
  if (typeof data !== 'object' || data === null) return null;
  const { receipt, replayed } = data as { receipt?: unknown; replayed?: unknown };
  return typeof receipt === 'string' ? { receipt, replayed: replayed === true } : null;
}

/** A 202 answer carries an operation to poll instead of a receipt. */
export const isPending = (data: unknown) => typeof data === 'object' && data !== null && 'operationId' in data;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * The key of one write: a digest of what it says and the head it expects. The same submit sent
 * again (a timeout, a double click) carries the same key and Main replays it; a changed input or a
 * moved head is a different write with a different key, never a conflict with the first.
 */
export async function writeKey(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return `w839:${hex(digest).slice(0, 48)}`;
}

/** A UUID derived from a write's key, so a retried creation names the same record rather than a second one. */
export async function idFrom(key: string, purpose: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}\n${purpose}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** The text fields of a submitted form, as the state keeps them for the next render. */
export function valuesOf(form: FormData): Values {
  const values: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string' || name.startsWith('$ACTION')) continue;
    values[name] = name in values ? `${values[name]}\n${value}` : value;
  }
  return values;
}
