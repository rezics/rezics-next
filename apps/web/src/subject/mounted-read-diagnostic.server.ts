import { getResponseHeader, setResponseHeader } from '@tanstack/react-start/server';
import {
  mountedSubjectReadHeader,
  mountedSubjectReadLimit,
  mountedSubjectReadReason,
  type MountedSubjectReadStage,
} from './mounted-read-diagnostic';

const documentPath = /^\/en\/subjects\/([0-9a-f-]{36})\/[^/]+(?:\/relations)?$/;

/** Keep the diagnostic on explicitly marked, ordinary loopback documents in the development Worker. */
export function mountedSubjectReadStage(
  document: Request,
  input: RequestInfo | URL,
  init?: RequestInit,
): MountedSubjectReadStage | undefined {
  if (!import.meta.env.DEV || document.method !== 'GET' || document.headers.get(mountedSubjectReadHeader) !== '1')
    return;
  const url = new URL(document.url);
  if (url.hostname !== '127.0.0.1' || url.search || !document.headers.get('accept')?.includes('text/html')) return;
  const id = documentPath.exec(url.pathname)?.[1];
  if (!id) return;
  const native = new URL(input instanceof Request ? input.url : String(input));
  if (native.protocol !== 'http:' || native.hostname !== '127.0.0.1') return;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method === 'POST' && native.pathname === '/v1/pages:read') return 'page';
  if (method === 'GET') {
    if (native.pathname === `/v1/subjects/${id}`) return 'subject';
    if (native.pathname === `/v1/subjects/${id}/links`) return 'links';
  }
}

export async function recordMountedSubjectRead(stage: MountedSubjectReadStage, response?: Response): Promise<void> {
  let outcome = response ? String(response.status) : 'transport';
  const length = response?.headers.get('content-length');
  if (
    response &&
    response.status >= 400 &&
    length &&
    /^\d{1,4}$/.test(length) &&
    Number(length) <= 2048 &&
    response.headers.get('content-type')?.startsWith('application/problem+json')
  ) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const reason = mountedSubjectReadReason(body && typeof body === 'object' && 'code' in body ? body.code : undefined);
    if (reason) outcome += ` ${reason}`;
  }
  const previous = getResponseHeader(mountedSubjectReadHeader);
  if (!previous || previous.split(',').length < mountedSubjectReadLimit)
    setResponseHeader(mountedSubjectReadHeader, [previous, `${stage} ${outcome}`].filter(Boolean).join(', '));
}
