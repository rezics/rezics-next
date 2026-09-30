import { createHash } from 'node:crypto';

/** The idempotency key of an identity choice, derived from what the form showed
 * (the expected revision and the chosen Agent). A browser that resubmits the same
 * form sends the same key and Main replays the result; a different choice or a
 * newer revision is a different key, so a stale form still fails as stale. */
export function choiceKey(scope: 'session' | 'main', ...parts: ReadonlyArray<string | null>): string {
  return `${scope}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 48)}`;
}
