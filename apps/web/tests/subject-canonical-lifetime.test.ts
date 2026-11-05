import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  awaitSubjectRoute,
  readSubjectCanonicalQuery,
  type SubjectCanonicalQueryOptions,
} from '../src/features/pages/subject-canonical-lifetime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}

test('one retired route releases its observer while another exact-query reader finishes', async () => {
  const client = new QueryClient();
  const started = deferred<void>();
  const reply = deferred<{ revision: number }>();
  let reads = 0;
  let nativeSignal: AbortSignal | undefined;
  const options: SubjectCanonicalQueryOptions<{ revision: number }> = {
    queryKey: ['subject-canonical', 'same-address'],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      reads++;
      nativeSignal = signal;
      started.resolve();
      return reply.promise;
    },
  };
  const current = new AbortController();
  const retired = new AbortController();
  const currentRead = readSubjectCanonicalQuery(client, options, current.signal);
  await started.promise;
  const retiredRead = readSubjectCanonicalQuery(client, options, retired.signal);
  retired.abort();
  await expect(retiredRead).rejects.toMatchObject({ name: 'AbortError' });
  expect(nativeSignal?.aborted).toBe(false);
  reply.resolve({ revision: 1 });
  await expect(currentRead).resolves.toEqual({ revision: 1 });
  expect(reads).toBe(1);
});

test('an ignored retired read cannot satisfy a fresh same-address return', async () => {
  const client = new QueryClient();
  const started = deferred<void>();
  const obsoleteReply = deferred<{ revision: number }>();
  let reads = 0;
  let retiredNativeSignal: AbortSignal | undefined;
  const options: SubjectCanonicalQueryOptions<{ revision: number }> = {
    queryKey: ['subject-canonical', 'return-address'],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      reads++;
      if (reads === 1) {
        retiredNativeSignal = signal;
        started.resolve();
        return obsoleteReply.promise;
      }
      return Promise.resolve({ revision: 2 });
    },
  };
  const retired = new AbortController();
  const obsoleteRead = readSubjectCanonicalQuery(client, options, retired.signal);
  await started.promise;
  retired.abort();
  await expect(obsoleteRead).rejects.toMatchObject({ name: 'AbortError' });
  expect(retiredNativeSignal?.aborted).toBe(true);
  obsoleteReply.resolve({ revision: 1 });
  await expect(readSubjectCanonicalQuery(client, options, new AbortController().signal)).resolves.toEqual({
    revision: 2,
  });
  expect(reads).toBe(2);
});

test('a route that ignores abort cannot settle a late success or error into its caller', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const late = deferred<{ kind: 'redirect' }>();
  let reads = 0;
  const result = awaitSubjectRoute(controller.signal, () => {
    reads++;
    started.resolve();
    return late.promise;
  });
  await started.promise;
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  late.resolve({ kind: 'redirect' });
  expect(reads).toBe(1);

  const alreadyRetired = new AbortController();
  alreadyRetired.abort();
  await expect(awaitSubjectRoute(alreadyRetired.signal, async () => ({ kind: 'error' }))).rejects.toMatchObject({
    name: 'AbortError',
  });
});
