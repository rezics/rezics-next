import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { createTypes, type InitialSubject } from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import { creationStatement, editableScalar, type StatementInput } from './statement-editor';

export const screenTypes = ['schema:Movie', 'schema:TVSeries', 'schema:TVSeason', 'schema:Episode'] as const;
export function isScreenType(type: string): boolean {
  return screenTypes.some((id) => id === type);
}
export type ScreenRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'unavailable' }
  | { ok: true; release: Release; public: SubjectRead | null };
export type ScreenItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type ScreenCommand = { item: ScreenItem; key: string };
export type ScreenGroup = 'dates' | 'amounts' | 'credits' | 'parts' | 'classification' | 'text' | 'authored';

/** Presentation groups only: the active emitted Type, datatype and relation metadata decide admission. */
export function screenGroups(release: Release, type: string): Record<ScreenGroup, string[]> {
  const groups: Record<ScreenGroup, string[]> = {
    dates: [],
    amounts: [],
    credits: [],
    parts: [],
    classification: [],
    text: [],
    authored: [],
  };
  if (!isScreenType(type)) return groups;
  for (const id of release.types[type]?.properties ?? []) {
    // Identity terms, media and publication choice have their own existing journeys.
    if (
      [
        'schema:name',
        'schema:description',
        'schema:alternateName',
        'schema:sameAs',
        'rezics:representativeEdition',
      ].includes(id)
    )
      continue;
    const property = release.properties[id];
    if (!property) continue;
    if (property.datatype === 'document') groups.authored.push(id);
    else if (property.datatype === 'wikibase-item' && property.relation) {
      groups[
        property.relation.group === 'classification'
          ? 'classification'
          : ['credit', 'appearance'].includes(property.relation.group)
            ? 'credits'
            : 'parts'
      ].push(id);
    } else if (editableScalar(property)) {
      groups[property.datatype === 'time' ? 'dates' : property.datatype === 'quantity' ? 'amounts' : 'text'].push(id);
    }
  }
  return groups;
}
export function screenCreateTypes(release: Release, locale: string) {
  return createTypes(release, locale).filter((entry) => isScreenType(entry.id));
}
export function screenTarget(release: Release, property: string, type: string): boolean {
  return (
    release.properties[property]?.targets?.some(
      (target) => target === type || release.types[type]?.bases.includes(target),
    ) === true
  );
}
export function screenFactId(property: string): string {
  return `screen-fact-${encodeURIComponent(property)}`;
}
export function screenInitialFacts(release: Release, initial: InitialSubject, statements: StatementInput[]) {
  const item: ScreenItem = { ...initial, statements: {} };
  for (const statement of statements)
    (item.statements[statement.property.id] ??= []).push(structuredClone(creationStatement(statement, release)));
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  const groups = screenGroups(release, item.type);
  const admitted = Object.entries(groups)
    .filter(([group]) => group !== 'authored')
    .flatMap(([, ids]) => ids);
  if (!isScreenType(item.type)) errors.push({ pointer: '/type', code: 'unsupported' });
  for (const id of Object.keys(item.statements)) {
    // Consent-dependent assertions belong to the existing consent-aware contribution editor.
    if (!admitted.includes(id) || release.properties[id]?.disclosure === 'sourceOrConsent')
      errors.push({ pointer: `/statements/${id}`, code: 'unsupported' });
  }
  return { item, errors };
}
export async function readScreenProfile(client: KernelClient, id?: string): Promise<ScreenRead> {
  try {
    const [subject, active] = await Promise.all([
      id ? client.subjects({ id }).get() : undefined,
      client.definitions.active.get(),
    ]);
    if (subject && [403, 404, 308].includes(subject.status)) return { ok: false, reason: 'concealed' };
    if (active.status !== 200 || !active.data || (id && (subject?.status !== 200 || subject.data?.subject.id !== id)))
      return { ok: false, reason: 'unavailable' };
    if (subject?.data && !isScreenType(subject.data.subject.type)) return { ok: false, reason: 'invalid' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    if (subject?.data && !release.types[subject.data.subject.type]) return { ok: false, reason: 'unavailable' };
    return { ok: true, release, public: subject?.data ?? null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
export async function createScreenProfile(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: ScreenCommand,
  locale: string,
  preparedAuthorization?: string,
) {
  if (!isScreenType(command.item.type)) return { ok: false as const, reason: 'invalid' as const };
  // Native validation and idempotency own this frozen command, including retries after a lost response.
  // Revalidating against a newer release here could discard the key of an already-created subject.
  return createSubjectRecord(client, request, env, command, locale, preparedAuthorization);
}
export function screenName(release: Release, property: string, locale: string) {
  const label = pickText(release.properties[property]?.labels ?? {}, locale);
  return label.text ? label : { text: property, lang: null };
}
