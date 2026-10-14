import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/instructions-in-any-form', {
  visitor: pending('reads exact published Post, recording, procedure and ordered instructions while drafts stay concealed'),
  stranger: pending('reads exact published instruction dependencies and transformation credit without peer editing or draft access'),
  member: pending('reads all published instruction forms without membership widening draft or dependency access'),
  owner: pending('adopts and publishes each form, replays changes and previews private successors without moving publication pins'),
  moderator: pending('reads pinned instructions and AI transformation credit without moderation granting peer custody'),
  operator: pending('reads pinned instructions and AI transformation credit without platform status granting peer custody'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original synthetic instructions and recording by the owner Person; procedure transformed by a represented AI service Agent, credited as transformation, never source author or rights clearance.' } });

// Target wire contracts, intentionally outside runtime code until the outcome
// is accepted. These selectors do not grant target access or follow latest.
export type ResourceSelector =
  | { grain: 'resource' }
  | { grain: 'revision'; revision: string }
  | { grain: 'occurrence'; structure: string; revision: string; occurrence: string }
  | { grain: 'content'; variantId: string; revision: string; block?: string }
  | { grain: 'representation'; revision: string; representation: string; fragment?: string };
export interface ResourceReference { target: string; selector: ResourceSelector }
export interface ExactContentReference extends ResourceReference {
  selector: Extract<ResourceSelector, { grain: 'content' }>;
}
export interface AuthoredPostRequest {
  profile: 'authored-post-v1'; title: { value: string; language: string };
  language: string; document: BlocksDocument; actingSubject: string;
}
export interface AuthoredPostResponse {
  post: string; variantId: string; revisionId: string; byteDigest: string;
  author: string; replayed: boolean;
}
export interface BlocksDocument {
  version: 'rezics-document-v1'; profile: 'blocks';
  doc: { type: 'doc'; content: DocumentNode[] };
}
export interface DocumentNode {
  type: string; attrs?: Record<string, unknown>; text?: string; content?: DocumentNode[];
}
export type ProcedureItem =
  | { id: string; type: 'HowToStep'; document: BlocksDocument }
  | { id: string; type: 'HowToSection'; name: { value: string; language: string }; items: ProcedureItem[] };
export interface ContentDerivationRequest {
  profile: 'content-derivation-v1'; output: ExactContentReference;
  inputs: ResourceReference[];
  activity: { kind: 'transcription' | 'translation' | 'transformation' | 'ai-generation' };
  responsibleAgent: string; expectedOutputHead: string; actingSubject: string;
}
export interface ContentDerivationRecord {
  derivation: string; output: ExactContentReference; inputs: ResourceReference[];
  activity: { id: string; kind: ContentDerivationRequest['activity']['kind'] };
  responsibleAgent: string; replayed: boolean;
}
export interface InstructionPage {
  structure: string; revision: string; next?: string;
  occurrences: { occurrence: string; role: string; target?: string }[];
  ingredients: { occurrence: string; amount?: { numerator: number; denominator: number }; originalText: string }[];
  instructions: { occurrence: string; reference: ResourceReference; status: 'available' | 'unavailable'; document?: BlocksDocument; mediaUse?: string }[];
  cost: { pages: number; occurrences: number };
}
export interface NativeRecipeExport {
  format: 'native'; structure: string; revision: string;
  occurrences: { occurrence: string; target?: string; selection?: { revision: string; selector: ResourceSelector } }[];
  contents: { reference: ExactContentReference; document: BlocksDocument }[];
  derivations: ContentDerivationRecord[]; losses: [];
}

export function document(content: DocumentNode[]): BlocksDocument {
  return { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content } };
}
export const paragraph = (id: string, text: string): DocumentNode => ({
  type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }],
});
export const resourceReference = (id: string, reference: ResourceReference, fallback: string,
  inline = false): DocumentNode => ({ type: inline ? 'extensionInline' : 'extensionBlock', attrs: {
  id, definition: 'https://rezics.com/definition/resource-reference-v1', version: '1', payload: reference, fallback,
} });
