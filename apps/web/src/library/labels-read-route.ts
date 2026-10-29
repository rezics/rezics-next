import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { clearLabelFeedback, loadLabelsPage } from './labels-read';
function validate(value: unknown): { cursor?: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    ('cursor' in value &&
      value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || value.cursor.length > 2048))
  )
    throw new Error('Invalid label cursor');
  return 'cursor' in value && typeof value.cursor === 'string' ? { cursor: value.cursor } : {};
}
export const readLabelsPage = createServerFn({ method: 'GET' })
  .validator(validate)
  .handler(({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('set-cookie', clearLabelFeedback());
    return loadLabelsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data.cursor);
  });
