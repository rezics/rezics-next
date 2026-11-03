import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import type { InitialSubject, CreateResult } from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import {
  correctionProperty,
  creationStatement,
  readStatementEditor,
  type EditorRead,
  type StatementInput,
} from './statement-editor';

export const literaryTypes = ['schema:Book', 'schema:BookSeries'] as const;
export type LiteraryType = (typeof literaryTypes)[number];
export const isLiteraryType = (type: string): type is LiteraryType => literaryTypes.some((id) => id === type);
export type LiteraryItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type LiteraryCommand = { item: LiteraryItem; key: string };
export type LiteraryRead =
  | Extract<EditorRead, { ok: false }>
  | { ok: true; release: Release; current: Extract<EditorRead, { ok: true }> | null };

/** Presentation selects from the effective emitted properties; YAML annotations are never executed here. */
export function literaryFields(release: Release, type: string, locale: string) {
  const properties =
    isLiteraryType(type) && pickText(release.types[type]?.labels ?? {}, locale).text
      ? (release.types[type]?.properties ?? [])
      : [];
  return {
    scalars: properties.filter(
      (id) => correctionProperty(release, type, id) && !!pickText(release.properties[id]!.labels, locale).text,
    ),
    relations: properties.filter((id) => !!release.properties[id]?.relation),
    authored: properties.filter((id) => release.properties[id]?.datatype === 'document'),
  };
}

export async function readLiteraryProfile(client: KernelClient, id?: string): Promise<LiteraryRead> {
  if (id) {
    const current = await readStatementEditor(client, { id });
    if (!current.ok) return current;
    if (!isLiteraryType(current.public.subject.type)) return { ok: false, reason: 'invalid' };
    if (!current.release.types[current.public.subject.type]) return { ok: false, reason: 'stale' };
    return { ok: true, release: current.release, current };
  }
  try {
    const active = await client.definitions.active.get();
    if (active.status !== 200 || !active.data) return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    return { ok: true, release, current: null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Only explicitly staged initial scalars enter POST. Relations and original prose use their integrated editors. */
export function literaryInitialItem(
  release: Release,
  initial: InitialSubject,
  statements: StatementInput[],
  locale: string,
) {
  const item: LiteraryItem = { ...initial, statements: {} };
  for (const statement of statements)
    (item.statements[statement.property.id] ??= []).push(structuredClone(creationStatement(statement, release)));
  const errors = validateLiteraryItem(release, item, locale);
  return { item, errors };
}
export function validateLiteraryItem(release: Release, item: LiteraryItem, locale: string): Violation[] {
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  if (!isLiteraryType(item.type)) errors.push({ pointer: '/type', code: 'unsupported' });
  const admitted = literaryFields(release, item.type, locale).scalars;
  for (const [property, statements] of Object.entries(item.statements ?? {})) {
    if (!admitted.includes(property)) errors.push({ pointer: `/statements/${property}`, code: 'unsupported' });
    for (const statement of statements)
      if (statement.property.id !== property)
        errors.push({ pointer: `/statements/${property}`, code: 'invalid_format' });
  }
  return errors;
}
export async function createLiteraryWork(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: LiteraryCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const metadata = await readLiteraryProfile(client);
  if (!metadata.ok) return { ok: false, reason: 'unavailable' };
  const errors = validateLiteraryItem(metadata.release, command.item, locale);
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  return createSubjectRecord(client, request, env, command, locale, preparedAuthorization);
}
