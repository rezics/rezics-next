import type { KernelClient } from '@rezics/client';

export type GeneratedArchiveRecoveryMethod = Extract<keyof KernelClient, 'libraryArchiveMerges'>;
type ArchiveOwner = ReturnType<KernelClient['libraryArchiveMerges']>;
type PersonalEntryOwner = ReturnType<KernelClient['libraryEntries']>;
type ProgressSessionOwner = ReturnType<KernelClient['progressSessions']>;
type Data<Call extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<Call>> extends { data: infer T } ? T : never
>;
export type NativeArchiveStatus = Data<ArchiveOwner['get']>;
export type NativeArchivePreview = Data<ArchiveOwner['preview']['get']>;
export type NativeArchiveResults = Data<ArchiveOwner['results']['get']>;
export type NativeArchiveReview = Data<ArchiveOwner['review']['patch']>;
export type NativeArchiveApply = Data<ArchiveOwner['apply']['post']>;
export type ArchiveReviewItem = Parameters<ArchiveOwner['review']['patch']>[0]['items'][number];
export type ArchiveConfirmation = Parameters<ArchiveOwner['apply']['post']>[0];
export type ArchiveRow = NativeArchivePreview['records'][number];
export type NativePersonalEntry = Data<PersonalEntryOwner['personal']['get']>;
export type NativeJournal = Data<ProgressSessionOwner['journal']['get']>;
export type ArchiveReply<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused'; status: number; code: string }
  | { kind: 'uncertain' };
export const archiveUploadBytes = 34 * 1024 * 1024;

export function archiveRecoveryAdmission(): { available: true } {
  return { available: true };
}

/** The installed native client owns every DTO and all file validation. */
export function archiveRecoveryNative(client: KernelClient, authorization: string) {
  const options = (signal?: AbortSignal) => ({
    headers: { authorization },
    fetch: { ...(signal === undefined ? {} : { signal }), cache: 'no-store' as const },
  });
  async function receive<T>(
    call: () => Promise<{ data: T | null; error: unknown; status: number }>,
  ): Promise<ArchiveReply<T>> {
    // Only a transport failure creates uncertainty. Unexpected programming errors still throw.
    let result;
    try {
      result = await call();
    } catch (error) {
      if (archiveTransportLost(error)) return { kind: 'uncertain' };
      throw error;
    }
    if (result.error) {
      if (result.status === 0 || result.status >= 500) return { kind: 'uncertain' };
      const error = result.error;
      const value = typeof error === 'object' && error !== null && 'value' in error ? error.value : null;
      const code =
        typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
          ? value.code
          : 'request_refused';
      return { kind: 'refused', status: result.status, code };
    }
    return { kind: 'ok', value: result.data! };
  }
  return {
    upload(archive: string | { base64: string }, key: string, signal?: AbortSignal) {
      const body =
        typeof archive === 'string'
          ? archive
          : new Blob([Uint8Array.from(atob(archive.base64), (character) => character.charCodeAt(0))], {
              type: 'application/json',
            });
      const headers = { authorization, 'idempotency-key': JSON.stringify(key), 'content-type': 'application/json' };
      return receive(() => client.libraryArchiveMerges.post(body, { ...options(signal), headers }));
    },
    status(id: string, signal?: AbortSignal) {
      return receive(() => client.libraryArchiveMerges({ id }).get(options(signal)));
    },
    preview(id: string, after = -1, signal?: AbortSignal) {
      return receive(() =>
        client.libraryArchiveMerges({ id }).preview.get({ ...options(signal), query: { after, limit: 100 } }),
      );
    },
    review(id: string, items: ArchiveReviewItem[], signal?: AbortSignal) {
      return receive(() => client.libraryArchiveMerges({ id }).review.patch({ items }, options(signal)));
    },
    apply(id: string, confirmation: ArchiveConfirmation, signal?: AbortSignal) {
      return receive(() => client.libraryArchiveMerges({ id }).apply.post(confirmation, options(signal)));
    },
    results(id: string, after = -1, signal?: AbortSignal) {
      return receive(() =>
        client.libraryArchiveMerges({ id }).results.get({ ...options(signal), query: { after, limit: 100 } }),
      );
    },
    cancel(id: string, signal?: AbortSignal) {
      return receive(() => client.libraryArchiveMerges({ id }).delete(undefined, options(signal)));
    },
    prune(id: string, signal?: AbortSignal) {
      return receive(() => client.libraryArchiveMerges({ id }).prune.post(undefined, options(signal)));
    },
    entry(subjectId: string, signal?: AbortSignal) {
      return receive(() => client.libraryEntries({ subjectId }).get({ ...options(signal), query: { view: 'FULL' } }));
    },
    personal(subjectId: string, signal?: AbortSignal) {
      return receive(() => client.libraryEntries({ subjectId }).personal.get(options(signal)));
    },
    journal(sessionId: string, signal?: AbortSignal) {
      return receive(() => client.progressSessions({ sessionId }).journal.get(options(signal)));
    },
    label(labelId: string, signal?: AbortSignal) {
      return receive(() =>
        client.libraryLabelAssignments.get({ ...options(signal), query: { labelId, view: 'FULL', limit: 1 } }),
      );
    },
  };
}
export type ArchiveRecoveryPort = ReturnType<typeof archiveRecoveryNative>;

/** Fetch's documented network failures can follow a committed native effect. */
export function archiveTransportLost(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    ['fetch failed', 'Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'].includes(
      error.message,
    )
  );
}
