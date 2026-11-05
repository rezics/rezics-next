import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { undoTarget, prepareNativeBulkUndo } from './bulk-operation-undo-native';

export const prepareBulkOperationUndo = createServerFn({ method: 'POST' })
  .validator(undoTarget)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return prepareNativeBulkUndo(kernelClient(), new Request(getRequest()), env as Partial<SessionEnv>, data);
  });
