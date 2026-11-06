import { type PageDocumentReference } from '@rezics/composition';
import type { DocumentView } from '../content/document-read.ts';
/** Consumer bounds, chosen before dispatch. The producer must bound bytes before reading a body. */
export declare function DOCUMENT_TEXT_COST(): Readonly<{
    documents: 8;
    sourceBytesPerDocument: number;
    textBytesPerSubject: number;
    serializedBytesPerSubject: number;
    excerptCodePoints: 240;
}>;
export declare const DOCUMENT_TEXT_RECIPE: 'public-native-text-v1';
type Failure = 'unsupported' | 'preparing' | 'unavailable';
export type DocumentTextCoverage = 'complete' | 'partial' | Failure;
export type DocumentTextRead = {
    status: 'public';
    document: DocumentView;
} | {
    status: 'absent' | Failure;
};
/** A consumer seam for the native public document owner, not an alternative body reader.
 * `read` must admit public plain-text rights independently of Subject accessibility and
 * enforce maxSourceBytes before fetching/materializing. It must not read attachment bytes.
 * `current` checks the exact selected Subject observation, references and native rights,
 * including changes during a read. Missing producer evidence is unavailable, never absence.
 * No account/reader state belongs in this public projection.
 */
export interface PublicDocumentTextSource {
    read(input: Readonly<{
        subject: string;
        reference: PageDocumentReference;
        maxSourceBytes: number;
    }>): Promise<DocumentTextRead>;
    current(input: Readonly<{
        subject: string;
        observation: string;
        references: readonly PageDocumentReference[];
    }>): Promise<boolean>;
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
export declare function selectDocumentText(subject: string, observation: string, disclosedSubject: unknown, properties: readonly string[], language: string): DocumentTextSelection;
/** Sequential native dispatch keeps the retained body heap at one bounded document.
 * Each independent reference retains its own text; phrases cannot cross bodies/languages.
 * A production publisher must not advertise this capability until this seam is installed.
 */
export declare function projectDocumentText(selection: DocumentTextSelection, source?: PublicDocumentTextSource): Promise<DocumentTextProjection>;
/** An engine-approved exact source window. Offsets alone never authorize a fragment link.
 * The caller binds the engine request and candidate to its executed query/generation.
 * Offsets use original UTF-16 source units, never engine HTML or normalized text offsets.
 */
export type DocumentTextWindow = Readonly<{
    start: number;
    end: number;
    text: string;
}>;
export type VerifiedDocumentExcerpt = Readonly<{
    status: 'available';
    text: string;
    language: string;
    source: Readonly<{
        document: string;
        candidate: string;
        digest: string;
        revision: number;
        extraction: string;
    }>;
    destination: Readonly<{
        kind: 'subject-document';
        subject: string;
        document: string;
    }>;
}> | Readonly<{
    status: 'unavailable' | 'restart';
}>;
/** Final disclosure re-reads the exact native public body and fences after bounded assembly.
 * The returned DTO has no indexed body, private state, HTML or inferred paragraph anchor.
 */
export declare function verifyDocumentTextWindow(projection: DocumentTextProjection, candidate: IndexedDocumentText, window: DocumentTextWindow, source?: PublicDocumentTextSource): Promise<VerifiedDocumentExcerpt>;
export {};
