import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import * as v from 'valibot';
import { ContextChoiceError, unavailableContextChoiceSource, type ContextChoiceSource } from './setup-context-picker';
import type { SetupChoice, SetupFailure } from './space-setup';

type DirectoryGet = KernelClient['contexts']['get'];
/** The producer admits at most 100; this consumer asks for one twenty-entry page without refill. */
export const SETUP_CONTEXT_DIRECTORY_LIMIT = 20;
export type ContextDirectoryPage = NonNullable<Awaited<ReturnType<DirectoryGet>>['data']>;
export type ContextDirectoryEntry = ContextDirectoryPage['contexts'][number];

/** Strict wire validation of the installed native GET /v1/contexts response. */
const directoryEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  kind: v.picklist(['global', 'community']),
  labels: v.record(v.string(), v.string()),
  state: v.picklist(['active', 'deleted']),
  deletedAt: v.nullable(v.string()),
  purgeAfter: v.nullable(v.string()),
});
const directoryPageSchema = v.strictObject({
  contexts: v.pipe(v.array(directoryEntrySchema), v.maxLength(SETUP_CONTEXT_DIRECTORY_LIMIT)),
  next: v.nullable(v.string()),
}) satisfies v.GenericSchema<ContextDirectoryPage>;
const lifecycleSchema = v.strictObject({ context: directoryEntrySchema });

/** Strict GET /v1/contexts page; extra keys or more than twenty rows are unavailable. */
export function parseNativeContextDirectoryPage(data: unknown): ContextDirectoryPage | null {
  const parsed = v.safeParse(directoryPageSchema, data);
  return parsed.success ? parsed.output : null;
}

/** Strict GET /v1/contexts/{id}/lifecycle body; a directory row is never inferred. */
export function parseNativeContextLifecycle(data: unknown): ContextDirectoryEntry | null {
  const parsed = v.safeParse(lifecycleSchema, data);
  return parsed.success ? parsed.output.context : null;
}
export type ContextDirectoryResult = ContextDirectoryPage | { kind: 'denied' | 'unavailable' };
export type ContextDirectoryInput = { query: string; cursor?: string; signal?: AbortSignal };
export const setupContextDirectorySchema = v.strictObject({
  query: v.pipe(v.string(), v.maxLength(256)),
  cursor: v.optional(v.string()),
});

/** Only the declared active, currently readable directory; never a catalogue or lifecycle writer. */
export type NativeContextDirectory = {
  get(options: {
    query: { query?: string; limit: typeof SETUP_CONTEXT_DIRECTORY_LIMIT; cursor?: string; deleted: false };
    headers: { authorization: string };
    fetch?: { signal: AbortSignal };
  }): Promise<{ data: ContextDirectoryPage | null; error: unknown; status: number }>;
};

/** Explicit unavailable injection for consumers without a directory dependency. */
export const unavailableNativeContextDirectory: NativeContextDirectory = {
  async get() {
    return { data: null, error: 'unavailable', status: 503 };
  },
};

/** One native page per query/Next; the server session supplies authorization for every read. */
export async function readSetupContextDirectory(
  directory: NativeContextDirectory,
  authorization: string,
  input: ContextDirectoryInput,
): Promise<ContextDirectoryResult> {
  if (!authorization) return { kind: 'denied' };
  try {
    if (input.signal?.aborted) return { kind: 'unavailable' };
    const query = input.query.trim();
    const result = await directory.get({
      query: {
        ...(query ? { query } : {}),
        limit: SETUP_CONTEXT_DIRECTORY_LIMIT,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        deleted: false,
      },
      headers: { authorization },
      ...(input.signal ? { fetch: { signal: input.signal } } : {}),
    });
    if (input.signal?.aborted) return { kind: 'unavailable' };
    if (result.status === 401 || result.status === 403 || result.status === 404) return { kind: 'denied' };
    if (result.status !== 200 || result.error || !result.data) return { kind: 'unavailable' };
    const page = v.safeParse(directoryPageSchema, result.data);
    return page.success ? page.output : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Directory labels are display data. Choosing still performs the independent native Context GET. */
export function nativeContextChoiceSource(
  directory: (input: ContextDirectoryInput) => Promise<ContextDirectoryResult>,
  verifyChoice: (id: string) => Promise<SetupChoice | SetupFailure>,
  locale: string,
): ContextChoiceSource {
  return {
    async search(input) {
      const result = await directory(input);
      if (input.signal?.aborted) throw new ContextChoiceError('unavailable');
      if ('kind' in result) throw new ContextChoiceError(result.kind);
      return {
        contexts: result.contexts
          .filter((entry) => entry.state === 'active')
          .map((entry) => ({ id: entry.id, label: pickText(entry.labels, locale).text || entry.id })),
        next: result.next,
      };
    },
    resolve: unavailableContextChoiceSource(verifyChoice).resolve,
  };
}
