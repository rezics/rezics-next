import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { checkStatementInput, checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import {
  initialTerms,
  type CreateResult,
  type CreatedReader,
  type InitialSubject,
  type TermDraft,
} from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import { proposeStatement, type ProposalCommand, type ProposalResult, type StatementInput } from './statement-editor';

export type RecipeItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type RecipeCommand = { item: RecipeItem; key: string };
export type RecipeProperty = NonNullable<Release['properties'][string]>;
export type RecipeRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'unavailable' }
  | { ok: true; release: Release; public: SubjectRead | null; fields: string[] };
export type RecipeTransport = {
  load: () => Promise<RecipeRead>;
  create: (command: RecipeCommand, replay?: boolean) => Promise<CreateResult>;
  propose: (command: ProposalCommand, replay?: boolean) => Promise<ProposalResult>;
  read: (id: string) => Promise<CreatedReader>;
};
export const recipeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Effective native identities, including the released material property (not schema:madeFromMaterial).
const fields: Record<string, string> = {
  'schema:recipeIngredient': 'monolingualtext',
  'wdt:P186': 'wikibase-item',
  'schema:cookTime': 'quantity',
  'schema:recipeYield': 'quantity',
  'schema:suitableForDiet': 'wikibase-item',
  'schema:recipeInstructions': 'document',
};
export function recipeFields(release: Release, locale: string): string[] {
  const profile = release.types['schema:Recipe'];
  if (!profile || !pickText(profile.labels, locale).text) return [];
  return Object.keys(fields).filter((id) => {
    const property = release.properties[id];
    return (
      !!property &&
      profile.properties.includes(id) &&
      property.datatype === fields[id] &&
      !!pickText(property.labels, locale).text
    );
  });
}
export function recipeTarget(release: Release, property: string, type: string): boolean {
  return (
    release.properties[property]?.targets?.some(
      (base) => type === base || release.types[type]?.bases.includes(base),
    ) === true
  );
}
/** Incompatible retained fields stay visible; contributors remove them before adding a current definition. */
export function recipePropertyCompatible(previous: RecipeProperty, current: RecipeProperty | undefined): boolean {
  if (!current) return false;
  const meaning = (property: RecipeProperty) => {
    const value = structuredClone(property) as unknown as Record<string, unknown>;
    delete value.labels;
    return JSON.stringify(value);
  };
  return meaning(previous) === meaning(current);
}
export async function readRecipeEditor(client: KernelClient, locale: string, id?: string): Promise<RecipeRead> {
  if (id !== undefined && !recipeUuid.test(id)) return { ok: false, reason: 'concealed' };
  try {
    const [subject, active] = await Promise.all([
      id ? client.subjects({ id }).get() : undefined,
      client.definitions.active.get(),
    ]);
    if (subject && (subject.status === 403 || subject.status === 404 || subject.status === 308))
      return { ok: false, reason: 'concealed' };
    if ((id && (subject?.status !== 200 || subject.data?.subject.id !== id)) || active.status !== 200 || !active.data)
      return { ok: false, reason: 'unavailable' };
    if (subject?.data && subject.data.subject.type !== 'schema:Recipe') return { ok: false, reason: 'invalid' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    return { ok: true, release, public: subject?.data ?? null, fields: recipeFields(release, locale) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
export function validateRecipe(release: Release, item: RecipeItem, locale: string): Violation[] {
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  if (item.type !== 'schema:Recipe') errors.push({ pointer: '/type', code: 'unsupported' });
  const admitted = recipeFields(release, locale);
  for (const [id, statements] of Object.entries(item.statements ?? {})) {
    if (!admitted.includes(id)) errors.push({ pointer: `/statements/${id}`, code: 'unsupported' });
    for (const statement of statements) {
      // The map key must never disguise a different assertion.
      if (statement.property.id !== id) errors.push({ pointer: `/statements/${id}`, code: 'invalid_format' });
    }
  }
  return errors;
}
function populatedSnak(part: { value: StatementInput['value'] }) {
  const content = (value: unknown): boolean => {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some(content);
    if (value && typeof value === 'object') return Object.values(value).some(content);
    return false;
  };
  return part.value.type !== 'value' || content(part.value.content);
}

/** Empty citation scaffolds are omitted; typed zero, false and novalue remain. */
export function recipeEvidence(statement: StatementInput): StatementInput {
  const next = structuredClone(statement);
  next.qualifiers = (next.qualifiers ?? []).filter(populatedSnak);
  next.references = next.references
    .map((group) => ({ parts: group.parts.filter(populatedSnak) }))
    .filter((group) => group.parts.length);
  return next;
}

export function recipeDraft(release: Release, locale: string, terms: TermDraft[], statements: StatementInput[]) {
  const initial = initialTerms('schema:Recipe', terms);
  const item: RecipeItem = { ...initial.item, statements: {} };
  for (const statement of statements) {
    const next = recipeEvidence(statement);
    (item.statements[next.property.id] ??= []).push(next);
  }
  return { item, errors: [...initial.errors, ...validateRecipe(release, item, locale)] };
}

export type RecipeEvidenceChange = 'retained' | 'added' | 'edited' | 'removed';
export type RecipeEvidenceChangeEntry = {
  change: RecipeEvidenceChange;
  current?: StatementInput['references'][number];
  next?: StatementInput['references'][number];
};
export function recipeEvidenceChanges(
  current: StatementInput['references'] | undefined,
  next: StatementInput['references'],
): RecipeEvidenceChangeEntry[] {
  const remaining = [...(current ?? [])];
  const changes: RecipeEvidenceChangeEntry[] = [];
  for (const group of next) {
    const index = remaining.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(group));
    if (index >= 0) {
      const retained = remaining.splice(index, 1)[0]!;
      changes.push({ change: 'retained', current: retained, next: group });
      continue;
    }
    const edited = remaining.shift();
    changes.push(edited ? { change: 'edited', current: edited, next: group } : { change: 'added', next: group });
  }
  for (const group of remaining) changes.push({ change: 'removed', current: group });
  return changes;
}
export async function createRecipe(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: RecipeCommand,
  locale: string,
  preparedAuthorization?: string,
  replay = false,
): Promise<CreateResult> {
  if (!replay) {
    const read = await readRecipeEditor(client, locale);
    if (!read.ok) return { ok: false, reason: 'unavailable' };
    const errors = validateRecipe(read.release, command.item, locale);
    if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  }
  return createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
}
export async function proposeRecipe(
  client: KernelClient,
  authorization: string,
  command: ProposalCommand,
  locale: string,
  replay = false,
): Promise<ProposalResult> {
  if (replay) return proposeStatement(client, authorization, command);
  const read = await readRecipeEditor(client, locale, command.id);
  if (!read.ok) return { ok: false, reason: read.reason === 'invalid' ? 'invalid' : 'unavailable' };
  if (!read.fields.includes(command.statement.property.id))
    return { ok: false, reason: 'invalid', refreshDefinitions: true };
  const errors = checkStatementInput(command.statement, read.release, { authoredDocuments: true }).violations;
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  const result = await proposeStatement(client, authorization, command);
  return !result.ok && result.reason === 'invalid' ? { ...result, refreshDefinitions: true } : result;
}
