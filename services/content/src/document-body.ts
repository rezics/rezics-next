import { documentText, parseDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';

/** One Content body remains one unit; UTF-16 is the author's API budget. */
export const CONTENT_TEXT_COST = { textUnits: 65_536, textBytes: 196_608, languageUnits: 100 } as const;

/** Admission and public/private recipes use the same Unicode and text bounds. */
export function checkedContentText(value: unknown): string {
  if (typeof value !== 'string' || value.length > CONTENT_TEXT_COST.textUnits
    || Buffer.byteLength(value, 'utf8') > CONTENT_TEXT_COST.textBytes
    || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error('invalid Content text');
  }
  return value;
}

export interface AuthoredBodyInput { body?: string; document?: DocumentSnapshot }
export interface DocumentBody { body: string; document?: DocumentSnapshot }
export interface PostNotesInput { before?: AuthoredBodyInput; after?: AuthoredBodyInput }
export interface PostNotes { before?: DocumentBody; after?: DocumentBody }

/** Notes are language-local Post parts; body/document remain the text projection. */
export const POST_NOTES_COST = { parts: 2, textUnitsPerPart: 8192,
  documentBytesPerPart: 1_000_000 } as const;
export const POST_CONTENT_MODEL = 'content-shape-v2' as const;

function noteParts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'before' && key !== 'after')) {
    throw new Error('invalid Post notes');
  }
  return value as Record<string, unknown>;
}

function noteBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'body' && key !== 'document')) {
    throw new Error('invalid Post note body');
  }
  return value as Record<string, unknown>;
}

/** At most two bounded documents, with no reads of another variant or revision. */
export function authoredPostNotes(value: PostNotesInput | undefined): PostNotes | undefined {
  if (value === undefined) return undefined;
  const parts = noteParts(value);
  const notes: PostNotes = {};
  for (const key of ['before', 'after'] as const) {
    if (parts[key] === undefined) continue;
    const input = noteBody(parts[key]);
    const part = authoredDocumentBody(input as AuthoredBodyInput, 3 * POST_NOTES_COST.textUnitsPerPart);
    if (part.body.length > POST_NOTES_COST.textUnitsPerPart) throw new Error('Post note exceeds text bound');
    notes[key] = part;
  }
  return notes;
}

export function retainedPostNotes(value: unknown): PostNotes | undefined {
  if (value === undefined) return undefined;
  const parts = noteParts(value);
  const notes: PostNotes = {};
  for (const key of ['before', 'after'] as const) {
    if (parts[key] === undefined) continue;
    const part = retainedDocumentBody(noteBody(parts[key]));
    if (part.body.length > POST_NOTES_COST.textUnitsPerPart) throw new Error('Post note exceeds text bound');
    notes[key] = part;
  }
  return notes;
}

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
  // Retention checks the revision bound, not an ingress owner's text budget.
  // Content, Contributions and replies admit different text sizes.
  if (value.document === undefined) return authoredDocumentBody({ body: value.body }, 1_000_000);
  const projected = authoredDocumentBody({ document: value.document as DocumentSnapshot }, 1_000_000);
  if (projected.body !== value.body) throw new Error('document text projection differs');
  return projected;
}
