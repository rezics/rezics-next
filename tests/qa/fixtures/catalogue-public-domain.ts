import type { Static } from 'typebox';
import type { RecipeMeasure } from '../../../services/main/src/modules/structure/format.ts';
import type { ingredientLine, recipeStep } from '../../../services/main/src/routes/recipe-qualifiers.ts';
import type { RetainedPersonaRealm } from '../support/personas.ts';
import type { AuditFilePin } from './audit-corpus-contract.ts';

export const publicDomainBaseline = '69eac3ceeaf885be70205a70248bc951e9d81cc9';
/** Retained array bytes, not a rewritten envelope or a replacement identity list. */
export const publicDomainOriginalArraySha256 = 'bf9f7abc94aa30887511c05c61bd0433c0fdbb894a2d7d7e30aacdb7e12efa6e';
export const privateRecipeText = 'PRIVATE unpublished catalogue recipe annotation';
export type Rational = { numerator: number; denominator: number };
export type Measure = Static<typeof RecipeMeasure>;
export type Ingredient = Static<typeof ingredientLine>;
export type Step = Static<typeof recipeStep>;

/** A quote from frozen source bytes, independently selected before product proof.
 * Normalized quantities/relations below require review against these citations;
 * a saved API answer is never the source oracle. */
export interface SourceQuote {
  file: string;
  sha256: string;
  exact: string;
}
export interface RecipeCitation {
  kind: 'manual-citation';
  author: string;
  url: string;
  license: string | null;
  rightsAssessmentId: string;
  transcriber: string;
}
export interface PublicRecipe {
  work: string;
  /** Existing producer's receipt:<command-id> pin, required for an additional native Work. */
  creationReceipt?: { path: string; sha256: string };
  workRevision: string;
  mainVersion: string;
  structure: string;
  revision: string;
  publisher: 'owner' | 'operator';
  source: { author: string; url: string; license: string | null } & (
    | { record: string; observation: string }
    | { record?: never; observation?: never });
  /** Independent citations have no retained Source record/observation. These
   * projections and local receipt pins come only from successful producer commands. */
  citation?: RecipeCitation;
  rightsAssessmentId?: string;
  rightsReceipt?: { path: string; sha256: string };
  publicationDecision?: string;
  selectedGeneration?: string;
  sourceRoot?: string;
  publicationReceipt?: { path: string; sha256: string };
  sourceReceipt?: { path: string; sha256: string };
  publishedRecipeReceipt?: { path: string; sha256: string };
  observedSource?: RecipeCitation;
  publishedRecipeRead?: RecipePage;
  observedMeasures?: Measure[];
  title: string;
  language: string;
  /** Complete depth-first receipt order, including groups and empty groups. */
  order: string[];
  ingredients: Array<{ occurrence: string; parent: string; qualifier: Ingredient; evidence: SourceQuote }>;
  steps: Array<{ occurrence: string; parent: string; qualifier: Step; evidence: SourceQuote }>;
  measures: Array<{ value: Measure; evidence: SourceQuote }>;
  /** An explicit absence in the retained source, not an empty successful read of unknown data. */
  nutrition: 'stated' | 'absent';
  substitutions: Array<{ alternative: string; for: string; declaredBy: string; evidence: SourceQuote }>;
}
export interface RealBook {
  work: string;
  /** Existing producer's receipt:<command-id> pin, required for an additional native Work. */
  creationReceipt?: { path: string; sha256: string };
  title: string;
  language: string;
  description: { value: string; language: string; evidence: SourceQuote };
  author: { agent: string; name: string; evidence: SourceQuote };
  composition: string;
  compositionRevision: string;
  /** Preserve unknown correspondence and platform as null, including every actual release. */
  releases: Array<{ id: string; revision: string; realization: string | null; realizationRevision: string | null;
    language: string | null; platform: string | null; evidence: SourceQuote }>;
  chapters: Array<{ occurrence: string; parent: string; target: string; selectedRevision: string;
    body: SourceQuote; bodyText: string }>;
}

/** Private metadata beside ONE consistent stopped owner backup. The producer uses
 * public commands and retainPersonaRealm/createCorpusBackupDriver; it is a fixture
 * prerequisite, not a replacement import or publication implementation. */
export interface PublicDomainCorpus {
  profile: 'catalogue-public-domain-corpus-v1';
  productRevision: typeof publicDomainBaseline;
  backup: string;
  preparationMs: number;
  preparationQaRun: string;
  personas: RetainedPersonaRealm;
  /** Original retained catalogue identities; no replacement UUIDs on restore. */
  importedWorks: string[];
  /** Unchanged original association ledger; additional native targets never enter importedWorks. */
  originals: AuditFilePin;
  richRecipe: PublicRecipe;
  noNutritionRecipe: PublicRecipe;
  /** Together exercise both bases, all coverage and provenance states. */
  nutritionRecipes: PublicRecipe[];
  book: RealBook;
}

export type PublicDomainSelection = 'book' | 'recipe' | 'nutrition';
/** Unselected branches may be absent; no empty or invented full-corpus placeholders. */
export type PublicDomainSelectedCorpus = Omit<PublicDomainCorpus,
  'book' | 'richRecipe' | 'noNutritionRecipe' | 'nutritionRecipes'>
  & Partial<Pick<PublicDomainCorpus, 'book' | 'richRecipe' | 'noNutritionRecipe' | 'nutritionRecipes'>>;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const native = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/rezics\.com\/id\/[a-f0-9-]{36}$/.test(value);

/** Compare against the pinned retained ledger, not merely a list of 113 distinct IDs. */
export function assertPublicDomainOriginalWorks(importedWorks: readonly string[], originals: unknown): void {
  const bindings: unknown = Array.isArray(originals) ? originals
    : object(originals) && originals.format === 'audit-original-bindings-v1' ? originals.bindings : undefined;
  if (!Array.isArray(bindings) || bindings.length !== 113)
    throw new Error('TEST PREMISE: the unchanged original 113 association ledger is required');
  for (const binding of bindings) {
    if (!object(binding) || !text(binding.sourceKey) || !native(binding.resource)
      || !native(binding.mainVersion) || !native(binding.revision) || !text(binding.readPath)
      || ![binding.resourcePointer, binding.mainVersionPointer, binding.revisionPointer]
        .every(pointer => typeof pointer === 'string' && pointer.startsWith('/')))
      throw new Error('TEST PREMISE: original source/native association is incomplete');
  }
  const identities = bindings as Array<Record<string, string>>;
  for (const key of ['sourceKey', 'resource', 'mainVersion'] as const) {
    if (new Set(identities.map(binding => binding[key])).size !== 113)
      throw new Error(`TEST PREMISE: original ${key} association is duplicated`);
  }
  const originalWorks = new Set(identities.map(binding => binding.resource));
  if (!Array.isArray(importedWorks) || importedWorks.length !== 113 || new Set(importedWorks).size !== 113
    || importedWorks.some(work => !originalWorks.has(work)))
    throw new Error('TEST PREMISE: retain exactly the original 113 imported Work identities');
}

/** Qualify actual native owner creation, independently of conversion or later source annotation. */
export function assertPublicDomainNativeCreation(target: { work: string; mainVersion?: string }, receipt: unknown): void {
  if (!object(receipt) || !text(receipt.id) || !text(receipt.phase)
    || receipt.method !== 'POST' || receipt.path !== '/v1/works'
    || typeof receipt.key !== 'string' || !/^[A-Za-z0-9:_./-]{1,128}$/.test(receipt.key)
    || receipt.key.startsWith('source-adopt-') || 'error' in receipt
    || typeof receipt.startedAt !== 'number' || !Number.isFinite(receipt.startedAt) || receipt.startedAt <= 0
    || typeof receipt.finishedAt !== 'number' || !Number.isFinite(receipt.finishedAt) || receipt.finishedAt < receipt.startedAt
    || !object(receipt.caller) || !text(receipt.caller.realm) || !text(receipt.caller.persona)
    || receipt.caller.persona === 'visitor' || !text(receipt.caller.accountId) || !native(receipt.caller.actingSubject)
    || !object(receipt.body) || receipt.body.profile !== 'metadata-only-v1' || !text(receipt.body.title)
    || receipt.body.actingSubject !== receipt.caller.actingSubject
    || !object(receipt.answer) || !native(target.work) || receipt.answer.work !== target.work
    || !native(receipt.answer.mainVersion) || !native(receipt.answer.workRevision) || !native(receipt.answer.mainRevision)
    || !text(receipt.answer.admissionId) || !object(receipt.answer.sourcePosition)
    || receipt.answer.sourcePosition.datasetId !== 'product' || !text(receipt.answer.sourcePosition.dataEpoch)
    || typeof receipt.answer.sourcePosition.sequence !== 'string' || !/^\d+$/.test(receipt.answer.sourcePosition.sequence)
    || !(receipt.status === 201 && receipt.answer.replayed === false || receipt.status === 200 && receipt.answer.replayed === true)
    || target.mainVersion !== undefined && receipt.answer.mainVersion !== target.mainVersion)
    throw new Error(`TEST PREMISE: ${target.work} needs its actual successful native creation owner receipt bound to this target`);
}

export interface RecipePage {
  profile: 'recipe-work-page-v1';
  structure: string;
  revision: string;
  occurrences: Array<{ occurrence: string; parent: string; role: string;
    qualifier?: Ingredient | Step | { type: string } }>;
  ingredients: Array<{ occurrence: string; originalText: string; amount?: Rational;
    amountUpper?: Rational; unitText?: string; scaled: boolean; reason?: string }>;
  measures: Measure[];
  next?: string;
}
