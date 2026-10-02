import {
  checkDocument,
  documentText,
  fromMarkdown,
  fromPlainText,
  hasDocumentContent,
  parseStoredDocument,
  serializeDocument,
  type DocumentSnapshot,
} from '@rezics/document';

/** Only editor-owned draft strings use this serialization; API bodies are always read explicitly. */
export function editorDocument(value: string): DocumentSnapshot {
  return parseStoredDocument(value) ?? fromPlainText(value);
}

/** The public API identifies structured content separately from an authored plain string. */
export function editorValue(body: string, document?: unknown): string {
  return serializeDocument(checkDocument(document) ? document : fromPlainText(body));
}

export function bodyText(value: string): string {
  const document = parseStoredDocument(value);
  return document ? documentText(document) : value;
}

export function hasBodyContent(value: string): boolean {
  const document = parseStoredDocument(value);
  return document ? hasDocumentContent(document) : Boolean(value.trim());
}

/** Old device drafts contain authored text, even when that text happens to be valid document JSON. */
export function restoreCachedBody(value: string, format?: 'document', markdown = false): string {
  if (format === 'document' || !parseStoredDocument(value)) return value;
  return serializeDocument(markdown ? fromMarkdown(value, 'blocks') : fromPlainText(value));
}

/** The owner derives its own plain projection, so a client cannot submit a conflicting copy. */
export function bodyInput(value: string): { body: string } | { document: DocumentSnapshot } {
  const document = parseStoredDocument(value);
  return document ? { document } : { body: value };
}
