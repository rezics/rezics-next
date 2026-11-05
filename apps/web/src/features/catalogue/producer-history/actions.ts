import { candidateAuthorization } from '../../../subject/candidate-admission';
import { originalReaderInput } from '../editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import { readProducerHistory, type ProducerHistoryRead } from './index';

export const readSubjectProducerHistory = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput(
      (input: {
        id: string;
        stream?: string | undefined;
        cursor?: string | undefined;
        session?: string | undefined;
      }) => {
        if (
          !input ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) ||
          (input.stream !== undefined && (typeof input.stream !== 'string' || input.stream.length > 256)) ||
          (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
          (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
        )
          throw new Error('Invalid producer history address');
        return { id: input.id, stream: input.stream, cursor: input.cursor, session: input.session };
      },
    ),
  )
  .handler(async ({ data }): Promise<ProducerHistoryRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    const client = kernelClient();
    return readProducerHistory(
      client,
      authorization,
      fetchGuideRelease(client, undefined, { authorization }),
      data.id,
      requestLocale() ?? 'en',
      data.stream,
      data.cursor,
      data.session,
    );
  });
