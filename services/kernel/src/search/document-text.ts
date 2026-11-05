import { memoizedValue } from '../memoized.ts';
import { createHash } from 'node:crypto';
import { pageDocumentReferences, type PageDocumentReference } from '@rezics/composition';
import { documentText, serializeDocument } from '@rezics/document';
import type { DocumentView } from '../content/document-read.ts';
import { MAX_DOCUMENT_BYTES } from '../content/document.ts';

/** Consumer bounds, chosen before dispatch. The producer must bound bytes before reading a body. */
export function DOCUMENT_TEXT_COST() {
  return memoizedValue(DOCUMENT_TEXT_COST, () =>
    Object.freeze({
      documents: 8,
      sourceBytesPerDocument: MAX_DOCUMENT_BYTES,
      textBytesPerSubject: 64 * 1024,
      serializedBytesPerSubject: 96 * 1024,
      excerptCodePoints: 240,
    }),
  );
}
export const DOCUMENT_TEXT_RECIPE = 'public-native-text-v1' as const;

type Failure = 'unsupported' | 'preparing' | 'unavailable';
export type DocumentTextCoverage = 'complete' | 'partial' | Failure;
export type DocumentTextRead = { status: 'public'; document: DocumentView } | { status: 'absent' | Failure };

/** A consumer seam for the native public document owner, not an alternative body reader.
 * `read` must admit public plain-text rights independently of Subject accessibility and
 * enforce maxSourceBytes before fetching/materializing. It must not read attachment bytes.
 * `current` checks the exact selected Subject observation, references and native rights,
 * including changes during a read. Missing producer evidence is unavailable, never absence.
 * No account/reader state belongs in this public projection.
 */
export interface PublicDocumentTextSource {
  read(
    input: Readonly<{
      subject: string;
      reference: PageDocumentReference;
      maxSourceBytes: number;
    }>,
  ): Promise<DocumentTextRead>;
  current(
    input: Readonly<{
      subject: string;
      observation: string;
      references: readonly PageDocumentReference[];
    }>,
  ): Promise<boolean>;
}

export type DocumentTextSelection = Readonly<{
  subject: string;
  /** Native immutable observation identity; never a timestamp fabricated by Search. */
  observation: string;
  references: readonly PageDocumentReference[];
}>;
export type IndexedDocumentText = Readonly<{
  reference: PageDocumentReference;
  revision: number;
  recipe: typeof DOCUMENT_TEXT_RECIPE;
  extraction: string;
  text: string;
  complete: boolean;
}>;
export type DocumentTextProjection = Readonly<{
  selection: DocumentTextSelection;
  coverage: DocumentTextCoverage;
  documents: readonly IndexedDocumentText[];
}>;

/** Use only an already disclosed native Subject and its configured document properties.
 * Property admission precedes reference selection and all body operations. */
export function selectDocumentText(
  subject: string,
  observation: string,
  disclosedSubject: unknown,
  properties: readonly string[],
  language: string,
): DocumentTextSelection {
  if (!language || language.length > 64 || properties.some((property) => !property || property.length > 256))
    throw new TypeError('Incomplete document text selection');
  if (properties.length > DOCUMENT_TEXT_COST().documents || new Set(properties).size !== properties.length)
    throw new RangeError('Document text properties exceed their bound or repeat');
  const references = pageDocumentReferences(disclosedSubject, properties, language);
  // Freeze our own copies: a caller cannot replace a selected reference during hydration.
  return retainSelection({ subject, observation, references });
}

function boundedSelection(selection: DocumentTextSelection): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !uuid.test(selection.subject) ||
    !selection.observation ||
    selection.observation.length > 2048 ||
    selection.references.length > DOCUMENT_TEXT_COST().documents ||
    selection.references.some(
      (reference) =>
        !uuid.test(reference.candidate) ||
        !uuid.test(reference.document) ||
        !/^[0-9a-f]{64}$/.test(reference.digest) ||
        !reference.language ||
        reference.language.length > 64,
    )
  )
    throw new RangeError('Document text selection exceeds its bound');
}
function retainSelection(selection: DocumentTextSelection): DocumentTextSelection {
  boundedSelection(selection);
  return Object.freeze({
    ...selection,
    references: Object.freeze(selection.references.map((reference) => Object.freeze({ ...reference }))),
  });
}
function binding(reference: PageDocumentReference): string {
  return JSON.stringify([reference.candidate, reference.document, reference.digest, reference.language]);
}
function matches(selection: DocumentTextSelection, reference: PageDocumentReference, value: DocumentView): boolean {
  return (
    value.subjectId === selection.subject &&
    value.id === reference.document &&
    value.candidateId === reference.candidate &&
    value.digest === reference.digest &&
    value.language === reference.language &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

/** UTF-8 prefix without splitting a Unicode code point. Prefix coverage is never complete. */
function prefix(text: string, maximum: number): { text: string; complete: boolean } {
  let bytes = 0,
    end = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maximum) return { text: text.slice(0, end), complete: false };
    bytes += size;
    end += point.length;
  }
  return { text, complete: true };
}
function identity(reference: PageDocumentReference, revision: number, text: string, complete: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify([DOCUMENT_TEXT_RECIPE, binding(reference), revision, text, complete]))
    .digest('hex');
}
function extract(
  selection: DocumentTextSelection,
  reference: PageDocumentReference,
  document: DocumentView,
  remaining: number,
): IndexedDocumentText | Failure {
  if (!matches(selection, reference, document) || document.availability !== 'available') return 'unavailable';
  // Blocks may contain media/opaque extensions. No new recipe is inferred from their fallback text.
  if (document.body.profile !== 'text') return 'unsupported';
  if (Buffer.byteLength(serializeDocument(document.body)) > DOCUMENT_TEXT_COST().sourceBytesPerDocument)
    return 'unavailable';
  const value = prefix(documentText(document.body), remaining);
  return Object.freeze({
    reference,
    revision: document.revision,
    recipe: DOCUMENT_TEXT_RECIPE,
    extraction: identity(reference, document.revision, value.text, value.complete),
    ...value,
  });
}

/** Sequential native dispatch keeps the retained body heap at one bounded document.
 * Each independent reference retains its own text; phrases cannot cross bodies/languages.
 * A production publisher must not advertise this capability until this seam is installed.
 */
export async function projectDocumentText(
  selection: DocumentTextSelection,
  source?: PublicDocumentTextSource,
): Promise<DocumentTextProjection> {
  selection = retainSelection(selection);
  const documents: IndexedDocumentText[] = [];
  const result = (coverage: DocumentTextCoverage): DocumentTextProjection => ({ selection, coverage, documents });
  if (!source) return result('unavailable');
  let remaining = DOCUMENT_TEXT_COST().textBytesPerSubject;
  let coverage: DocumentTextCoverage = 'complete';
  const degrade = (status: DocumentTextCoverage) => {
    const rank = { complete: 0, partial: 1, unsupported: 2, preparing: 3, unavailable: 4 };
    if (rank[status] > rank[coverage]) coverage = status;
  };
  try {
    if (!(await source.current(selection))) return result('unavailable');
    for (const reference of selection.references) {
      if (!remaining) {
        degrade('partial');
        break;
      }
      const read = await source.read({
        subject: selection.subject,
        reference,
        maxSourceBytes: DOCUMENT_TEXT_COST().sourceBytesPerDocument,
      });
      if (read.status === 'absent') continue;
      if (read.status !== 'public') {
        degrade(read.status);
        continue;
      }
      const extracted = extract(selection, reference, read.document, remaining);
      if (typeof extracted === 'string') {
        degrade(extracted);
        continue;
      }
      documents.push(extracted);
      remaining -= Buffer.byteLength(extracted.text);
      if (!extracted.complete) degrade('partial');
    }
    if (!(await source.current(selection))) return { selection, coverage: 'unavailable', documents: [] };
    if (Buffer.byteLength(JSON.stringify(documents)) > DOCUMENT_TEXT_COST().serializedBytesPerSubject)
      return { selection, coverage: 'unavailable', documents: [] };
    return result(coverage);
  } catch {
    return { selection, coverage: 'unavailable', documents: [] };
  }
}

/** An engine-approved exact source window. Offsets alone never authorize a fragment link.
 * The caller binds the engine request and candidate to its executed query/generation.
 * Offsets use original UTF-16 source units, never engine HTML or normalized text offsets.
 */
export type DocumentTextWindow = Readonly<{ start: number; end: number; text: string }>;
export type VerifiedDocumentExcerpt =
  | Readonly<{
      status: 'available';
      text: string;
      language: string;
      source: Readonly<{ document: string; candidate: string; digest: string; revision: number; extraction: string }>;
      destination: Readonly<{ kind: 'subject-document'; subject: string; document: string }>;
    }>
  | Readonly<{ status: 'unavailable' | 'restart' }>;

function windowValid(text: string, window: DocumentTextWindow): boolean {
  if (
    text.length > DOCUMENT_TEXT_COST().textBytesPerSubject ||
    window.text.length > DOCUMENT_TEXT_COST().excerptCodePoints * 2
  )
    return false;
  const { start, end } = window;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length)
    return false;
  // Reject surrogate halves at either edge, without normalizing source text.
  const splitsPair = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!);
  return (
    !splitsPair(start) &&
    !splitsPair(end) &&
    text.slice(start, end) === window.text &&
    [...window.text].length <= DOCUMENT_TEXT_COST().excerptCodePoints
  );
}

/** Final disclosure re-reads the exact native public body and fences after bounded assembly.
 * The returned DTO has no indexed body, private state, HTML or inferred paragraph anchor.
 */
export async function verifyDocumentTextWindow(
  projection: DocumentTextProjection,
  candidate: IndexedDocumentText,
  window: DocumentTextWindow,
  source?: PublicDocumentTextSource,
): Promise<VerifiedDocumentExcerpt> {
  boundedSelection(projection.selection);
  if (!source || candidate.recipe !== DOCUMENT_TEXT_RECIPE || !windowValid(candidate.text, window))
    return { status: 'unavailable' };
  const { selection } = projection;
  const reference = selection.references.find((reference) => binding(reference) === binding(candidate.reference));
  const indexed = projection.documents.find(
    (document) =>
      document.extraction === candidate.extraction && binding(document.reference) === binding(candidate.reference),
  );
  if (!reference || !indexed) return { status: 'restart' };
  try {
    if (!(await source.current(selection))) return { status: 'restart' };
    const read = await source.read({
      subject: selection.subject,
      reference,
      maxSourceBytes: DOCUMENT_TEXT_COST().sourceBytesPerDocument,
    });
    if (read.status !== 'public') return { status: read.status === 'absent' ? 'restart' : 'unavailable' };
    // Reproduce this reference's original prefix budget, not the whole Subject's allowance.
    const current = extract(selection, reference, read.document, Buffer.byteLength(candidate.text));
    if (typeof current === 'string') return { status: 'unavailable' };
    if (current.extraction !== candidate.extraction || !windowValid(current.text, window)) return { status: 'restart' };
    const excerpt: VerifiedDocumentExcerpt = {
      status: 'available',
      text: window.text,
      language: reference.language,
      source: {
        document: reference.document,
        candidate: reference.candidate,
        digest: reference.digest,
        revision: current.revision,
        extraction: current.extraction,
      },
      destination: { kind: 'subject-document', subject: selection.subject, document: reference.document },
    };
    return (await source.current(selection)) ? excerpt : { status: 'restart' };
  } catch {
    return { status: 'unavailable' };
  }
}
