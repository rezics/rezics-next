import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { loadMineCollectionsPage, type MineCollectionsPage } from './mine-collections';

function validateInput(input: unknown): { cursor?: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    ('cursor' in input &&
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || input.cursor.length > 2048))
  )
    throw new Error('Invalid collection cursor');
  return 'cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {};
}

export const readMineCollectionsPage = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<MineCollectionsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMineCollectionsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
