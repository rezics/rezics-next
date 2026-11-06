import { CONTENT_DOCUMENT_BYTES, type AdmitDocumentReadInput } from '../contract/index.ts';

/** A passed deadline withholds the document before any storage is touched. */
export function deadlineElapsed(now: number, deadline: number): boolean {
  return !Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline;
}

export function admitDocumentByteLimit(maxSourceBytes: number | undefined, maxBytes = CONTENT_DOCUMENT_BYTES): boolean {
  return (
    maxSourceBytes === undefined ||
    (Number.isSafeInteger(maxSourceBytes) && maxSourceBytes >= 1 && maxSourceBytes <= maxBytes)
  );
}

export function admitDocumentRead(input: AdmitDocumentReadInput): boolean {
  return (
    input.route !== null &&
    Number.isInteger(input.route) &&
    input.route >= 0 &&
    !deadlineElapsed(input.now, input.deadline) &&
    admitDocumentByteLimit(input.maxSourceBytes, input.maxBytes)
  );
}

export function documentReadExhausted(now: number, deadline: number, found: unknown): boolean {
  return found == null || deadlineElapsed(now, deadline);
}
