import type { KernelClient } from '@rezics/client';
import { archiveTransportLost } from '../archive-entry-recovery/native';

type Root = ReturnType<KernelClient['libraryCopyArchives']>;
type ReviewRoot = ReturnType<Root['progressReviews']>;
type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer T } ? T : never
>;
export type Upload = Data<KernelClient['libraryCopyArchives']['post']>;
export type Holdings = Data<Root['get']>;
export type Occurrences = Data<Root['progress']['get']>;
export type Units = Data<ReturnType<Root['progress']>['units']['get']>;
export type Review = Data<Root['progressReviews']['post']>;
export type ReviewInput = Parameters<Root['progressReviews']['post']>[0];
export type Application = Data<ReviewRoot['$apply']['post']>;
export type Result = Data<ReviewRoot['get']>;
export type Reply<T> = { kind: 'ok'; value: T } | { kind: 'uncertain' } | { kind: 'refused'; status: number };
export const UPLOAD_BYTES = 32 * 1024 * 1024;

export async function receive<T>(
  call: () => Promise<{ data: T | null; error: unknown; status: number }>,
): Promise<Reply<T>> {
  let result;
  try {
    result = await call();
  } catch (error) {
    if (archiveTransportLost(error)) return { kind: 'uncertain' };
    throw error;
  }
  if (result.error)
    return result.status === 0 || result.status >= 500
      ? { kind: 'uncertain' }
      : { kind: 'refused', status: result.status };
  return { kind: 'ok', value: result.data! };
}

/** Base64 is only the Web HTTP envelope. The generated native request receives the original JSON bytes. */
export function progressRecoveryNative(client: KernelClient, authorization: string) {
  const options = () => ({ headers: { authorization }, fetch: { cache: 'no-store' as const } });
  const write = (key: string) => ({ ...options(), headers: { authorization, 'idempotency-key': JSON.stringify(key) } });
  const root = (id: string) => client.libraryCopyArchives({ id });
  return {
    upload(base64: string, key: string) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const options = write(key);
      const headers = { ...options.headers, 'content-type': 'application/json' };
      return receive(() =>
        client.libraryCopyArchives.post(new Blob([bytes], { type: 'application/json' }), {
          ...options,
          headers,
        }),
      );
    },
    holdings(id: string, after = -1) {
      return receive(() => root(id).get({ ...options(), query: { after } }));
    },
    occurrences(id: string, after = -1) {
      return receive(() => root(id).progress.get({ ...options(), query: { after } }));
    },
    units(id: string, sessionId: string, after = -1) {
      return receive(() =>
        root(id)
          .progress({ sessionId })
          .units.get({ ...options(), query: { after } }),
      );
    },
    review(id: string, body: ReviewInput, key: string) {
      return receive(() => root(id).progressReviews.post(body, write(key)));
    },
    apply(id: string, reviewId: string, key: string) {
      return receive(() => root(id).progressReviews({ reviewId }).$apply.post(undefined, write(key)));
    },
    result(id: string, reviewId: string) {
      return receive(() => root(id).progressReviews({ reviewId }).get(options()));
    },
    cancel(id: string) {
      return receive(() => root(id).$cancel.post(undefined, options()));
    },
    remove(id: string) {
      return receive(() => root(id).delete(undefined, options()));
    },
    subject(subjectId: string) {
      return receive(() =>
        client.subjects({ id: subjectId }).get({ ...options(), fetch: { cache: 'no-store', redirect: 'manual' } }),
      );
    },
  };
}
export type NativePort = ReturnType<typeof progressRecoveryNative>;

/** Composition stays generic so native journey fixtures do not load Web server modules. */
export type ProgressRecoveryPort<Choices = unknown> = Omit<NativePort, 'subject'> & {
  choices(subjectId: string): Promise<Reply<{ subjectId: string; choices: Choices | undefined }>>;
};
