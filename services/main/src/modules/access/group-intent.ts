import { createHash } from 'node:crypto';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Bind the API's validated command body to one owner-local idempotency key. */
export function groupChangeIntentDigest(command: Record<string, unknown>): string {
  return createHash('sha256').update(stable(command)).digest('hex');
}
