import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { handleLabelForm, submitLabel, validateLabelInput } from './labels-read';

// Every form preserves its own Idempotency-Key across retries, as Collection forms do.
export const manageLabel = createServerFn({ method: 'POST' })
  .validator(validateLabelInput)
  .handler(({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitLabel(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
export const labelsFormPost = createServerOnlyFn(({ request }: { request: Request }) =>
  handleLabelForm(kernelClient(), request, env as Partial<SessionEnv>),
);
