import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import {
  cancelDiaryContinuation,
  readConsumptionSummary,
  readDiaryPage,
  readReportedYearSummary,
  type ReportedYearRead,
  type ConsumptionSummary,
  type DiaryRead,
  type DiaryReadFailure,
} from './native';

import { diarySearch, type DiaryAddress } from './address';

type PrivateIdentity = { viewer: string; csrfToken: string; authorization: string };

async function currentIdentity(): Promise<PrivateIdentity | null> {
  const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
  return identity.state === 'signed-in' && identity.csrfToken
    ? { viewer: identity.subject, csrfToken: identity.csrfToken, authorization: identity.authorization }
    : null;
}

export type PrivateDiaryLoad = {
  kind: 'ready';
  address: DiaryAddress;
  reportedYear: ReportedYearRead | null;
  viewer: string;
  csrfToken: string;
  diary: DiaryRead;
  summary: { kind: 'ready'; value: ConsumptionSummary } | DiaryReadFailure | { kind: 'not-selected' };
};

export type PrivateDiaryLoadResult = PrivateDiaryLoad | { kind: 'signed-out' | 'unavailable' };

function thrownReadFailure(error: unknown): DiaryReadFailure {
  return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
}

export const readPrivateDiary = createServerFn({ method: 'GET' })
  .validator((value: unknown) =>
    diarySearch(value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}),
  )
  .handler(async ({ data }): Promise<PrivateDiaryLoadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity) return { kind: 'signed-out' };
    const client = kernelClient();
    const [diary, summary, reportedYear] = await Promise.all([
      readDiaryPage(client, identity.authorization, data.cursor, { year: data.year, month: data.month }).catch(
        thrownReadFailure,
      ),
      data.year === undefined
        ? readConsumptionSummary(client, identity.authorization).catch(thrownReadFailure)
        : Promise.resolve({ kind: 'not-selected' as const }),
      data.year === undefined
        ? null
        : readReportedYearSummary(client, identity.authorization, data.year).catch(thrownReadFailure),
    ]);
    return {
      kind: 'ready',
      address: data,
      reportedYear,
      viewer: identity.viewer,
      csrfToken: identity.csrfToken,
      diary,
      summary: summary.kind === 'ready' ? { kind: 'ready', value: summary.summary } : summary,
    };
  });

export const cancelPrivateDiary = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diary cancellation');
    const item = value as Record<string, unknown>;
    if (
      typeof item.viewer !== 'string' ||
      typeof item.csrfToken !== 'string' ||
      typeof item.continuation !== 'string' ||
      item.continuation.length < 1 ||
      item.continuation.length > 8192
    )
      throw new Error('Invalid diary cancellation');
    return { viewer: item.viewer, csrfToken: item.csrfToken, continuation: item.continuation };
  })
  .handler(async ({ data }): Promise<'cancelled' | 'retired' | 'unavailable'> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await currentIdentity();
    if (!identity || identity.viewer !== data.viewer || identity.csrfToken !== data.csrfToken) return 'retired';
    try {
      return await cancelDiaryContinuation(kernelClient(), identity.authorization, data.continuation);
    } catch {
      return 'unavailable';
    }
  });
