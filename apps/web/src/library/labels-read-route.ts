import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { clearLabelFeedback, loadLabelsPage } from './labels-read';
function validate(value: unknown): { cursor?: string; query?: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid label query');
  const input = value as Record<string, unknown>;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    throw new Error('Invalid label cursor');
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4096))
    throw new Error('Invalid label prefix');
  return {
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...(typeof input.query === 'string' ? { query: input.query } : {}),
  };
}
export const readLabelsPage = createServerFn({ method: 'GET' })
  .validator(validate)
  .handler(({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('set-cookie', clearLabelFeedback());
    return loadLabelsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data.cursor, data.query);
  });
