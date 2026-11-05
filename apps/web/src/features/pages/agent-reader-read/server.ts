import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../../kernel/client';
import { loadSettingsPage } from '../../../settings/preferences';
import { agentReaderResult, type AgentReaderResult } from './result';

/** Reader preferences are loaded by the browser after hydration; they never affect public HTML. */
export const readAgentReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { handle, locale, expectedReader } = record;
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) throw notFound();
    if (typeof locale !== 'string' || locale.length > 35) throw notFound();
    if (typeof expectedReader !== 'string' || expectedReader.length === 0 || expectedReader.length > 128)
      throw notFound();
    return { handle, locale, expectedReader };
  })
  .handler(async ({ data }): Promise<AgentReaderResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadSettingsPage(
      kernelClient(data.locale),
      request,
      env as Parameters<typeof loadSettingsPage>[2],
      {
        signal: request.signal,
      },
    );
    return agentReaderResult(data.expectedReader, page);
  });
