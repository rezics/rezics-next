import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { validExpectedReader, prepareExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import {
  validFollowInput,
  writeFollowRecord,
  type FollowWriteInput,
  type FollowWriteResult,
} from '../../library/follow-records';

/** Aggregate advice never authorizes a mutation. Reuse the native idempotent Library writer. */
export const writeCollectionFollow = createServerFn({ method: 'POST' })
  .validator((input: FollowWriteInput & ExpectedReader) => {
    if (!validExpectedReader(input) || !validFollowInput(input) || typeof input.following !== 'boolean')
      throw new Error('Invalid Collection follow command');
    return { ...input };
  })
  .handler(async ({ data }): Promise<FollowWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ env }, { kernelClient }] = await Promise.all([
      import('cloudflare:workers'),
      import('../../kernel/client'),
    ]);
    const request = getRequest();
    if (!(await prepareExpectedReader(request, env, data))) return { ok: false, reason: 'unauthorized' };
    return writeFollowRecord(kernelClient(), request, env, data);
  });
