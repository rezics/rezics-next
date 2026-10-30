import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { loadMineCollectionsPage, type MineCollectionsPage } from './mine-collections';

function validateInput(input: unknown): { cursor?: string; layout?: 'rows' | 'previews' } {
  if (
    !input ||
    typeof input !== 'object' ||
    ('cursor' in input &&
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || input.cursor.length > 4096)) ||
    ('layout' in input && input.layout !== undefined && input.layout !== 'rows' && input.layout !== 'previews')
  )
    throw new Error('Invalid collection page input');
  return {
    ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
    ...('layout' in input && (input.layout === 'rows' || input.layout === 'previews') ? { layout: input.layout } : {}),
  };
}

export const readMineCollectionsPage = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<MineCollectionsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMineCollectionsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
