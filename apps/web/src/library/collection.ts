import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient } from '../kernel/client';
import { publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { loadEditableCollectionPage, type EditableCollectionPage } from './collection-load';

function validatePageInput(input: unknown): { id: string; cursor?: string; credentialMode: ReadCredentialMode } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 128 ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
    ('credentialMode' in input &&
      input.credentialMode !== undefined &&
      input.credentialMode !== 'anonymous' &&
      input.credentialMode !== 'session')
  )
    throw notFound();
  return {
    id: input.id,
    ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
    credentialMode: 'credentialMode' in input && input.credentialMode === 'session' ? 'session' : 'anonymous',
  };
}

export const readCollectionPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<EditableCollectionPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const page = await loadEditableCollectionPage(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      data.credentialMode,
    );
    await nameSubjectTypes(page.members.map((member) => member.subject));
    return page;
  });

export function collectionPageQuery(id: string, cursor: string | undefined, credentialMode: ReadCredentialMode) {
  return queryOptions({
    ...publicRead,
    queryKey: readQueryKey(['collection-page', id, cursor ?? null], credentialMode),
    queryFn: () =>
      readCollectionPage({
        data: { id, ...(cursor === undefined ? {} : { cursor }), credentialMode },
      }),
  });
}
