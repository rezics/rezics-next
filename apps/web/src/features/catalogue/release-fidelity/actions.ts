import { candidateAuthorization } from '../../../subject/candidate-admission';
import { originalReaderInput } from '../editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { releaseUuid } from './model';
import { readReleaseFidelity, type ReleaseFidelityRead } from './read';

export const readSubjectReleaseFidelity = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput(
      (input: {
        id: string;
        context?: string | undefined;
        stream?: string | undefined;
        cursor?: string | undefined;
        detail?: string | undefined;
        session?: string | undefined;
      }) => {
        if (
          !input ||
          !releaseUuid.test(input.id) ||
          (input.context !== undefined && !releaseUuid.test(input.context)) ||
          (input.stream !== undefined && (typeof input.stream !== 'string' || input.stream.length > 256)) ||
          (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
          (input.detail !== undefined && !releaseUuid.test(input.detail)) ||
          (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
        )
          throw new Error('Invalid release address');
        return {
          id: input.id,
          context: input.context,
          stream: input.stream,
          cursor: input.cursor,
          detail: input.detail,
          session: input.session,
        };
      },
    ),
  )
  .handler(async ({ data }): Promise<ReleaseFidelityRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return readReleaseFidelity(kernelClient(), authorization, {
      id: data.id,
      context: data.context,
      locale: requestLocale() ?? 'en',
      stream: data.stream,
      cursor: data.cursor,
      detail: data.detail,
      session: data.session,
    });
  });
