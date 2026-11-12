import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../kernel/client';
import { exportKnowledgeTransfer, parseKnowledgeTransferSource } from './transfer';

/** Anonymous public export stays public even when this caller happens to own the source. */
export const exportKnowledgePublicTransferRequest = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    const source = parseKnowledgeTransferSource(value);
    if (!source || source.representation !== 'public') throw new Error('Invalid Knowledge public export source');
    return source;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return exportKnowledgeTransfer((decorate) => kernelClient(undefined, undefined, decorate), data);
  });
