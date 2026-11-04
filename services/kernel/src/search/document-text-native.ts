import {
  readDocument,
  type DocumentReadDependencies,
  type DocumentView,
} from '../content/document-read.ts';
import { MAX_DOCUMENT_BYTES } from '../content/document.ts';
import type { ReadContext } from '../content/model.ts';
import type { PageDocumentReference } from '@rezics/composition';
import type { DocumentTextRead, PublicDocumentTextSource } from './document-text.ts';

type BoundedDocumentRead = (
  dependencies: DocumentReadDependencies,
  id: string,
  context: ReadContext,
  maxSourceBytes?: number,
) => Promise<{ document: DocumentView } | null>;

/**
 * Compose Content's bounded body reader with the current native selection and rights fence.
 * The current probe is supplied by the native owners so it can check subject selection and
 * document rights without loading bodies a second time.
 */
export function createPublicDocumentTextSource(input: Readonly<{
  dependencies: DocumentReadDependencies;
  context: ReadContext;
  current: PublicDocumentTextSource['current'];
  read?: BoundedDocumentRead;
}>): PublicDocumentTextSource {
  const boundedRead = input.read ?? readDocument;
  const read = async ({ subject, reference, maxSourceBytes }: Parameters<PublicDocumentTextSource['read']>[0]): Promise<DocumentTextRead> => {
    if (
      !Number.isSafeInteger(maxSourceBytes) ||
      maxSourceBytes < 1 ||
      maxSourceBytes > MAX_DOCUMENT_BYTES
    )
      return { status: 'unavailable' };
    try {
      const result = await boundedRead(input.dependencies, reference.document, input.context, maxSourceBytes);
      if (!result || !currentReference(result.document, subject, reference)) return { status: 'unavailable' };
      return { status: 'public', document: result.document };
    } catch {
      return { status: 'unavailable' };
    }
  };
  return {
    read,
    current: input.current,
  };
}

function currentReference(
  document: DocumentView,
  subject: string,
  reference: PageDocumentReference,
): boolean {
  return (
    document.availability === 'available' &&
    document.subjectId === subject &&
    document.id === reference.document &&
    document.candidateId === reference.candidate &&
    document.digest === reference.digest &&
    document.language === reference.language &&
    Number.isSafeInteger(document.revision) &&
    document.revision >= 1
  );
}
