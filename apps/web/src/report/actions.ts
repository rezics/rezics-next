import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { validateReport } from './draft';
import { submitReport } from './submit.server';

export const sendReport = createServerFn({ method: 'POST' })
  .validator(validateReport)
  .handler(({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitReport(getRequest(), env as Partial<SessionEnv>, data, kernelClient());
  });
