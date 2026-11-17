import type { Holdings, Occurrences, Upload } from '../../src/library/archive-progress-recovery/native';

export function archiveProgressOperation(method: string, path: string) {
  return method === 'POST' && path === '/v1/libraryCopyArchives'
    ? 'upload'
    : method === 'GET' && /^\/v1\/libraryCopyArchives\/[^/]+\/progress$/u.test(path)
      ? 'occurrences'
      : method === 'GET' && /^\/v1\/libraryCopyArchives\/[^/]+$/u.test(path)
        ? 'holdings'
        : null;
}

/** Keep only counts, page ordinals and categorical response metadata from the owned Archive boundary. */
export async function observeArchiveProgressResponse(request: Request, response: Response) {
  const url = new URL(request.url);
  const operation = archiveProgressOperation(request.method, url.pathname);
  if (operation === null) return;
  const contentType = response.headers.get('content-type')?.split(';')[0];
  const metadata = {
    operation,
    firstPage: operation !== 'upload' && (url.searchParams.get('after') ?? '-1') === '-1',
    status: response.status,
    json: contentType === 'application/json',
    privateNoStore: response.headers.get('cache-control') === 'private, no-store',
  };
  if (!response.ok || !metadata.json) return { ...metadata, result: null };
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as Upload | Holdings | Occurrences | null;
  if (!body || typeof body !== 'object') return { ...metadata, result: null };
  const expiresAt = Date.parse(body.expiresAt);
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const occurrences = 'occurrences' in body && Array.isArray(body.occurrences) ? body.occurrences : null;
  const rows = 'rows' in body && Array.isArray(body.rows) ? body.rows : null;
  return {
    ...metadata,
    result: {
      expiry: !Number.isFinite(expiresAt) ? 'invalid' : expiresAt > Date.now() ? 'future' : 'expired',
      holdings: 'holdings' in body ? count(body.holdings) : null,
      progressRecords: 'progressRecords' in body ? count(body.progressRecords) : null,
      state: 'state' in body && ['inspecting', 'cancelled'].includes(body.state) ? body.state : null,
      rows: occurrences?.length ?? rows?.length ?? null,
      ordinals: occurrences?.slice(0, 10).map((row) => count(row?.ordinal)) ?? null,
      sessionRows: occurrences?.every((row) => row?.evidence?.section === 'sessions') ?? null,
      hasNext: 'next' in body ? body.next !== null : null,
    },
  };
}

export type ArchiveProgressResponse = Awaited<ReturnType<typeof observeArchiveProgressResponse>>;
