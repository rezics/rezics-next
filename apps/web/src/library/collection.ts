import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { loadCollectionPage, type CollectionPageData } from './reads';

function validatePageInput(input: unknown): { id: string; cursor?: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 128 ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string')
  )
    throw notFound();
  return {
    id: input.id,
    ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
  };
}

export const readCollectionPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<CollectionPageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    const page = await loadCollectionPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    await nameSubjectTypes(page.members.map((member) => member.subject));
    return page;
  });
