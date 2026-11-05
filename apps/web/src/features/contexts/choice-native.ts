import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import {
  readSetupContextDirectory,
  type ContextDirectoryInput,
  type ContextDirectoryEntry,
  type NativeContextDirectory,
} from '../../community/setup-context-native';

export type ContextChoiceFailure = { kind: 'denied' | 'unavailable' | 'invalid'; field?: 'query' | 'cursor' };
export type ContextChoices = { contexts: ContextDirectoryEntry[]; next: string | null };
export type ContextChoiceRead = { context: ContextDirectoryEntry } | ContextChoiceFailure;
const entry = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  kind: v.picklist(['global', 'community']),
  labels: v.record(v.string(), v.string()),
  state: v.picklist(['active', 'deleted']),
  deletedAt: v.nullable(v.string()),
  purgeAfter: v.nullable(v.string()),
});
const exact = v.strictObject({ context: entry });
export const contextChoiceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function contextChoiceInput(input: { query: string; cursor?: string }): ContextChoiceFailure | null {
  if (typeof input.query !== 'string' || input.query.length > 256) return { kind: 'invalid', field: 'query' };
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    return { kind: 'invalid', field: 'cursor' };
  return null;
}

/** Reuse setup's strict native 20-row parser, without changing setup's unavailable default or callers. */
export async function readContextChoices(
  directory: NativeContextDirectory,
  authorization: string,
  input: ContextDirectoryInput,
): Promise<ContextChoices | ContextChoiceFailure> {
  const invalid = contextChoiceInput(input);
  if (invalid) return invalid;
  const result = await readSetupContextDirectory(directory, authorization, input);
  if ('kind' in result) return result;
  if (result.next !== null && result.next.length > 4096) return { kind: 'invalid', field: 'cursor' };
  return { contexts: result.contexts.filter((context) => context.state === 'active'), next: result.next };
}

/** An independent exact lifecycle read is mandatory; a directory row is never a read or accept grant. */
export async function readContextChoice(
  client: KernelClient,
  authorization: string,
  id: string,
  signal?: AbortSignal,
): Promise<ContextChoiceRead> {
  if (!contextChoiceId.test(id)) return { kind: 'invalid' };
  if (!authorization) return { kind: 'denied' };
  try {
    if (signal?.aborted) return { kind: 'unavailable' };
    const result = await client.contexts({ id }).lifecycle.get({
      headers: { authorization },
      ...(signal ? { fetch: { signal } } : {}),
    });
    if (signal?.aborted) return { kind: 'unavailable' };
    if ([401, 403, 404].includes(result.status)) return { kind: 'denied' };
    if (result.status !== 200 || result.error) return { kind: 'unavailable' };
    const parsed = v.safeParse(exact, result.data);
    if (!parsed.success || parsed.output.context.id !== id) return { kind: 'unavailable' };
    if (parsed.output.context.state !== 'active') return { kind: 'denied' };
    return parsed.output;
  } catch {
    return { kind: 'unavailable' };
  }
}
