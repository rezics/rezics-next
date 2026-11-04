import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import {
  validFollowInput,
  writeFollowRecord,
  type FollowWriteInput,
  type FollowWriteResult,
} from '../../library/follow-records';
import {
  matchesExpectedReader,
  prepareExpectedReader,
  validExpectedReader,
  type ExpectedReader,
} from '../../session/expected-reader';

/** Retain Library's writer and response semantics; fence its final transport against session replacement. */
export const writeSearchSpaceFollow = createServerFn({ method: 'POST' })
  .validator((input: FollowWriteInput & ExpectedReader) => {
    if (!validExpectedReader(input) || !validFollowInput(input) || typeof input.following !== 'boolean')
      throw new Error('Invalid Search Space follow');
    return structuredClone(input);
  })
  .handler(async ({ data }): Promise<FollowWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { kernelClient }] = await Promise.all([
      import('cloudflare:workers'),
      import('../../kernel/client'),
    ]);
    const request = getRequest();
    const authorization = await prepareExpectedReader(request, env, data);
    if (!authorization) return { ok: false, reason: 'unauthorized' };
    const client = kernelClient(
      undefined,
      undefined,
      (fetcher) =>
        (async (url, init) => {
          if (!matchesExpectedReader(request, data)) throw new Error('Search reader retired');
          return fetcher(url, init);
        }) as typeof fetch,
    );
    return writeFollowRecord(client, request, env, data);
  });
