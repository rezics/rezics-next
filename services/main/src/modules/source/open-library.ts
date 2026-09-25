import type { ManualSourceIntake, SourceCapture } from './intake.ts';

export class OpenLibraryAcquisitionInvalid extends Error {}
export class OpenLibraryAcquisitionMissing extends Error {}
export class OpenLibraryAcquisitionUnavailable extends Error {}

const WORK_ID = /^OL[1-9][0-9]{0,11}W$/;
const MAX_BYTES = 65_536;

export interface OpenLibraryWorkCapture {
  input: ManualSourceIntake;
  capture: SourceCapture;
}

export function checkedOpenLibraryWorkId(value: string): string {
  if (!WORK_ID.test(value)) throw new OpenLibraryAcquisitionInvalid('invalid Open Library Work ID');
  return value;
}

function headerValue(value: string | null): string | null {
  if (value === null) return null;
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OpenLibraryAcquisitionUnavailable('Open Library response metadata is invalid');
  }
  return value;
}

async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.body) throw new OpenLibraryAcquisitionUnavailable('Open Library response has no body');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    throw new OpenLibraryAcquisitionUnavailable('Open Library response exceeds the capture limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new OpenLibraryAcquisitionUnavailable('Open Library response exceeds the capture limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OpenLibraryAcquisitionUnavailable) throw error;
    throw new OpenLibraryAcquisitionUnavailable('Open Library response was interrupted');
  } finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== size) {
    throw new OpenLibraryAcquisitionUnavailable('Open Library response length is incomplete');
  }
  return Buffer.concat(chunks, size);
}

/** Fixed-origin single-Work fetch; no caller-controlled URL or redirect is admitted. */
export async function fetchOpenLibraryWork(workId: string,
  fetcher: typeof fetch = fetch): Promise<OpenLibraryWorkCapture> {
  checkedOpenLibraryWorkId(workId);
  const url = `https://openlibrary.org/works/${workId}.json`;
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(5_000), headers: {
        accept: 'application/json', 'user-agent': 'REZICS-source-capture/1 (single-record lookup)',
      } });
  } catch {
    throw new OpenLibraryAcquisitionUnavailable('Open Library request failed');
  }
  if (response.status === 404) throw new OpenLibraryAcquisitionMissing('Open Library Work was not found');
  if (response.status !== 200) throw new OpenLibraryAcquisitionUnavailable('Open Library response is unavailable');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new OpenLibraryAcquisitionUnavailable('Open Library response is not JSON');
  }
  const bytes = await responseBytes(response);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new OpenLibraryAcquisitionUnavailable('Open Library response is malformed JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as { key?: unknown }).key !== `/works/${workId}`
    || typeof (parsed as { title?: unknown }).title !== 'string') {
    throw new OpenLibraryAcquisitionUnavailable('Open Library response has the wrong Work identity');
  }
  const revision = (parsed as { revision?: unknown }).revision;
  const sourceRevision = Number.isSafeInteger(revision) && Number(revision) >= 0
    ? `open-library-revision:${revision}` : null;
  const fetchedAt = new Date().toISOString();
  return { input: { provider: 'open-library', namespace: 'work', externalId: workId,
    sourceRevision, mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: bytes.toString('base64'),
    coverage: { scope: 'open-library-work-response-v1', complete: true,
      omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: 'Reuse basis has not been assessed.' } },
  capture: { profile: 'open-library-work-acquisition-v1', url, status: 200,
    etag: headerValue(response.headers.get('etag')),
    lastModified: headerValue(response.headers.get('last-modified')),
    fetchedAt } };
}
