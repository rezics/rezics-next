import { MAX_PAGE_DOCUMENTS, pageDocumentReferences } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { serializeDocument } from '@rezics/document';
import { createHash } from 'node:crypto';
import { readDocument, type DocumentReadDependencies } from '../content/document-read.ts';
import { publicDocument, type PublicDocumentView } from '../content/document-public.ts';
import type { AnchoredPosition, ReadContext } from '../content/model.ts';
import type { Item } from './item.ts';

/** Preview limits apply before body transfer and again to the complete retained DTO. */
export const characterDocumentBounds = {
  documents: MAX_PAGE_DOCUMENTS,
  sourceBytes: 262_144,
  responseBytes: 1_048_576,
} as const;

export type CharacterDocumentRelease = {
  types?: Record<string, { bases?: readonly string[]; properties?: readonly string[] }>;
  properties?: Record<string, { datatype?: string }>;
};

/** Only current released document fields on this Character can select a body. */
export function characterDocumentProperties(
  release: CharacterDocumentRelease | undefined,
  type: string,
  available: readonly string[],
): string[] {
  if (type !== 'wd:Q95074') return [];
  const admitted = new Set(release?.types?.[type]?.properties ?? []);
  return available.filter((id) => admitted.has(id) && release?.properties?.[id]?.datatype === 'document').sort();
}

/**
 * Read immutable bodies from the existing document authority under this caller.
 * A missing, erased, oversized or mismatched body stays absent from the map:
 * CandidateValue then exposes its existing unavailable state and read retry.
 * This does not read an editor or grant any editorial operation.
 */
export async function readCharacterPublicDocuments(
  dependencies: DocumentReadDependencies,
  subject: Item,
  release: Release,
  context: ReadContext,
  locale: string,
): Promise<{ documents: Record<string, PublicDocumentView>; anchors: AnchoredPosition[] } | undefined> {
  if (subject.type !== 'wd:Q95074') return;
  const properties = characterDocumentProperties(release, subject.type, Object.keys(subject.statements));
  const references = pageDocumentReferences(subject, properties, locale).slice(0, characterDocumentBounds.documents);
  const documents: Record<string, PublicDocumentView> = {};
  const anchors: AnchoredPosition[] = [];
  // Serial native reads release their homes before opening the next source home.
  // No Subject read, candidate scan or historical selection is performed here.
  let bytes = 2; // JSON object braces; each admitted entry also charges its key and separator.
  for (const reference of references) {
    const result = await readDocument(dependencies, reference.document, context, characterDocumentBounds.sourceBytes);
    if (!result) continue;
    anchors.push(...result.anchors);
    const document = result.document;
    if (
      document.id !== reference.document ||
      document.subjectId !== subject.id ||
      document.candidateId !== reference.candidate ||
      document.language !== reference.language ||
      document.digest !== reference.digest ||
      document.availability !== 'available'
    )
      continue;
    const canonical = serializeDocument(document.body);
    if (
      Buffer.byteLength(canonical) > characterDocumentBounds.sourceBytes ||
      createHash('sha256').update(canonical).digest('hex') !== reference.digest
    )
      continue;
    const view = publicDocument(document);
    const entryBytes =
      Buffer.byteLength(JSON.stringify(reference.candidate)) + 1 + Buffer.byteLength(JSON.stringify(view));
    const separator = Object.keys(documents).length ? 1 : 0;
    if (bytes + separator + entryBytes > characterDocumentBounds.responseBytes) continue;
    bytes += separator + entryBytes;
    documents[reference.candidate] = view;
  }
  return { documents, anchors };
}
