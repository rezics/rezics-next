import { checkDocument, type DocumentSnapshot } from '@rezics/document';

/** Bind only the document.get representation admitted for this exact statement on this page. */
export function statementDocument(
  subject: string,
  statement: { id?: string; value: { type: string; content?: unknown } },
  documents: unknown,
): DocumentSnapshot | undefined {
  if (statement.value.type !== 'value') return;
  const content = statement.value.content;
  if (!content || typeof content !== 'object' || !('document' in content) || !('language' in content)) return;
  // Existing direct public representations may already carry a validated snapshot.
  if (checkDocument(content.document)) return content.document;
  if (!documents || typeof documents !== 'object' || !statement.id || !Object.hasOwn(documents, statement.id)) return;
  const document: unknown = Reflect.get(documents, statement.id);
  if (
    !document ||
    typeof document !== 'object' ||
    !('body' in document) ||
    !('id' in document) ||
    document.id !== content.document ||
    !('subjectId' in document) ||
    document.subjectId !== subject ||
    !('candidateId' in document) ||
    document.candidateId !== statement.id ||
    !('digest' in document) ||
    !('digest' in content) ||
    document.digest !== content.digest ||
    !('language' in document) ||
    document.language !== content.language ||
    !('availability' in document) ||
    document.availability !== 'available'
  )
    return;
  return checkDocument(document.body) ? document.body : undefined;
}
