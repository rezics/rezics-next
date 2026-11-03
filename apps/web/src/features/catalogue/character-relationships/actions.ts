import { candidateAuthorization } from '../../../subject/candidate-admission';
import { originalReaderInput } from '../editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../../kernel/client';
import { fetchGuideRelease } from '../definition-guide';
import { readTypeDescriptor } from '../type-directory-client';
import { parseCharacterRelationshipsAddress } from './navigation';
import { readCharacterRelationships, type CharacterRelationshipsRead } from './reading';

export const readCharacterRelationshipsPage = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput(
      (input: {
        id: string;
        stream?: string | undefined;
        cursor?: string | undefined;
        session?: string | undefined;
      }) => {
        const address = parseCharacterRelationshipsAddress(input);
        if (
          !address ||
          (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
        )
          throw new Error('Invalid character relationships address');
        return {
          id: address.id,
          stream: address.stream,
          cursor: address.cursor,
          session: input.session,
        };
      },
    ),
  )
  .handler(async ({ data }): Promise<CharacterRelationshipsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    const client = kernelClient();
    const locale = requestLocale() ?? 'en';
    return readCharacterRelationships(
      client,
      authorization,
      fetchGuideRelease(client, undefined, { authorization }),
      data.id,
      locale,
      data.stream,
      data.cursor,
      data.session,
      (typeId) => readTypeDescriptor(client, typeId, locale),
    );
  });
