import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules';
import type { ZonePageTarget } from '../../zones/appearance';
import { BOOK_CANDIDATE_ZONE_IDS, readBookCandidatePage } from '../../zones/candidates/book';

type CandidateRead = ReturnType<typeof readBookCandidatePage>;

function targetFrom(value: unknown): ZonePageTarget | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const target = (value as { target?: unknown }).target;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined;
  const record = target as Record<string, unknown>;
  if (typeof record.route === 'string') return { route: record.route };
  if (typeof record.subject === 'string') {
    if (record.view !== undefined && record.view !== 'overview') return undefined;
    return {
      subject: record.subject,
      ...(record.view === 'overview' ? { view: 'overview' } : {}),
    };
  }
  return undefined;
}

function recording(result: Exclude<CandidateRead, { kind: 'decline' }>): KernelRecording {
  if (result.kind === 'page') {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: result.response,
    } as unknown as KernelRecording;
  }
  return {
    status: result.status,
    headers: {
      'content-type': 'application/json',
      ...(result.retryAfter ? { 'retry-after': result.retryAfter } : {}),
    },
    body: { error: { code: result.code, message: result.message } },
  } as unknown as KernelRecording;
}

async function answer(request: Request, zoneId: string): Promise<KernelRecording | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return recording({
      kind: 'error',
      status: 404,
      code: 'not_found',
      message: 'The requested page was not found.',
    });
  }
  const target = targetFrom(body);
  if (!target) {
    return recording({
      kind: 'error',
      status: 404,
      code: 'not_found',
      message: 'The requested page was not found.',
    });
  }
  const result = readBookCandidatePage(zoneId, target);
  return result.kind === 'decline' ? undefined : recording(result);
}

export const routes: FakeRoute[] = Object.values(BOOK_CANDIDATE_ZONE_IDS).map((zoneId) => ({
  method: 'POST',
  path: `/v1/zones/${zoneId}:readPage`,
  story: ({ request }) => answer(request, zoneId),
  fixture: ({ request }) => answer(request, zoneId),
}));
