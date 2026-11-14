import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import { insightsSearch } from './address';
import { readInsights, type InsightsRead } from './native';

export type PrivateInsightsResult =
  | { kind: 'received'; viewer: string; read: InsightsRead }
  | { kind: 'signed-out' | 'unavailable' };

export const readPrivateInsights = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid insights year');
    const record = input as Record<string, unknown>;
    const selected = insightsSearch(record).year;
    if (Object.keys(record).some((key) => key !== 'year') || typeof selected !== 'number')
      throw new Error('Invalid insights year');
    return { year: selected };
  })
  .handler(async ({ data }): Promise<PrivateInsightsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
    if (identity.state !== 'signed-in') return { kind: identity.state };
    return {
      kind: 'received',
      viewer: identity.subject,
      read: await readInsights(kernelClient(), identity.authorization, data.year),
    };
  });
