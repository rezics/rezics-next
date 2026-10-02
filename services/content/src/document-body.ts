import { documentText, parseDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';

export interface AuthoredBodyInput { body?: string; document?: DocumentSnapshot }
export interface DocumentBody { body: string; document?: DocumentSnapshot }

/** Ingress accepts one source of truth. The stored text is always an owner projection. */
export function authoredDocumentBody(input: AuthoredBodyInput, maxTextBytes = 65_536): DocumentBody {
  if ((input.body === undefined) === (input.document === undefined)) {
    throw new Error('provide exactly one body or document');
  }
  const document = input.document === undefined ? undefined
    : parseDocument(JSON.parse(serializeDocument(parseDocument(input.document))));
  const body = document ? documentText(document) : input.body!;
  if (typeof body !== 'string' || body.includes('\0')
    || Buffer.byteLength(body, 'utf8') > maxTextBytes
    || Buffer.from(body, 'utf8').toString('utf8') !== body) {
    throw new Error('invalid text body');
  }
  if (document && Buffer.byteLength(serializeDocument(document), 'utf8') > 1_000_000) {
    throw new Error('document exceeds revision size');
  }
  return { body, ...(document ? { document } : {}) };
}

/** Exact reads check the projection as well as byte custody, before consumers use it. */
export function retainedDocumentBody(value: Record<string, unknown>): DocumentBody {
  if (typeof value.body !== 'string') throw new Error('source has no text body');
  if (value.document === undefined) return authoredDocumentBody({ body: value.body });
  const projected = authoredDocumentBody({ document: value.document as DocumentSnapshot });
  if (projected.body !== value.body) throw new Error('document text projection differs');
  return projected;
}
