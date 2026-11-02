import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import { initialTerms, type TermDraft, type CreateResult, type CreatedReader } from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import type { SessionEnv } from '../../session/client';
import type { StatementInput, EditorRead } from './statement-editor';
import type { RelationRead } from '../../subject/relation-candidates';
import { readTypeDescriptor, type CurrentTypeDescriptor, type CurrentTypeRead } from './type-directory-client';

export const characterType = 'wd:Q95074';
export const characterUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CharacterItem = ReturnType<typeof initialTerms>['item'] & { statements: Record<string, StatementInput[]> };
export type CharacterCommand = { item: CharacterItem; key: string };
export type CharacterRead =
  | { ok: false; reason: 'invalid' | 'denied' | 'stale' | 'unavailable' }
  | {
      ok: true;
      release: Release;
      character: SubjectRead | null;
      work: SubjectRead | null;
      workDescriptor: CurrentTypeDescriptor | null;
    };
export type CharacterAddress = { id?: string | undefined; work?: string | undefined };
// Retained profile content stays mounted for drafts; expose it only after a settled successful read matches this address.
export function isCurrentCharacterRead(
  read: CharacterRead | undefined,
  query: { isSuccess: boolean; isFetching: boolean },
  address: CharacterAddress,
): read is Extract<CharacterRead, { ok: true }> {
  return (
    query.isSuccess &&
    !query.isFetching &&
    read?.ok === true &&
    (address.id === undefined ? read.character === null : read.character?.subject.id === address.id) &&
    (address.work === undefined
      ? read.work === null
      : read.work?.subject.id === address.work && read.workDescriptor?.typeId === read.work.subject.type)
  );
}
export function currentCharacterRead(
  read: CharacterRead | undefined,
  address: CharacterAddress,
  fetching: boolean,
  error: boolean,
): read is Extract<CharacterRead, { ok: true }> {
  return isCurrentCharacterRead(read, { isSuccess: !error, isFetching: fetching }, address);
}
export type CharacterTransport = {
  load: (address: CharacterAddress) => Promise<CharacterRead>;
  create: (command: CharacterCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
  workType?: (typeId: string) => Promise<CurrentTypeRead>;
};

/** Presentation groups intersect the effective native profile; they never add vocabulary. */
export function characterGroups(release: Release) {
  const admitted = release.types[characterType]?.properties ?? [];
  const groups = {
    identity: ['schema:abstract', 'schema:alternateName'],
    traits: ['schema:gender', 'schema:keywords', 'wdt:P1853'],
    measurements: ['schema:birthDate', 'schema:height', 'schema:weight'],
    identifiers: ['wdt:P3180', 'wdt:P6296', 'schema:url', 'schema:sameAs'],
  };
  return Object.fromEntries(
    Object.entries(groups).map(([group, fields]) => [
      group,
      fields.filter((id) => admitted.includes(id) && !!release.properties[id]),
    ]),
  ) as Record<keyof typeof groups, string[]>;
}
type TypeFields = Pick<Release, 'types' | 'properties'>;
export function characterWork(release: TypeFields, type: string): boolean {
  return characterWorkFields(release, type).length > 0;
}
export function characterWorkFields(release: TypeFields, type: string): string[] {
  return (release.types[type]?.properties ?? []).filter((id) => {
    const property = release.properties[id];
    return (
      property?.datatype === 'wikibase-item' &&
      ((id === 'schema:character' && property.targets?.includes(characterType)) ||
        (property.relation?.group === 'credit' &&
          property.relation.slotKey === 'wdt:P453' &&
          property.qualifiers.includes('wdt:P453')))
    );
  });
}
export function characterWorkDefinitions(descriptor: CurrentTypeDescriptor): TypeFields {
  return { types: { [descriptor.typeId]: descriptor.definition }, properties: descriptor.properties };
}
/** Suggestions default to eight results. Each actual Type already has effective inherited properties. */
export async function filterCharacterWorks<T extends { types: readonly string[] }>(
  entries: readonly T[],
  descriptor: NonNullable<CharacterTransport['workType']>,
  signal: AbortSignal,
): Promise<T[]> {
  const page = entries.slice(0, 8);
  const types = [...new Set(page.flatMap((entry) => (entry.types[0] ? [entry.types[0]] : [])))];
  signal.throwIfAborted();
  const support = new Map(
    await Promise.all(
      types.map(async (type) => {
        const read = await descriptor(type);
        if (!read.ok && read.reason !== 'missing') throw new Error('Work Type descriptor unavailable');
        if (read.ok && read.descriptor.typeId !== type) throw new Error('Work Type descriptor mismatch');
        return [type, read.ok && characterWork(characterWorkDefinitions(read.descriptor), type)] as const;
      }),
    ),
  );
  signal.throwIfAborted();
  return page.filter((entry) => support.get(entry.types[0] ?? '') === true);
}
export function characterRelations(read: RelationRead, release: TypeFields): RelationRead {
  if (!read.ok) return read;
  if (!characterWork(release, read.public.subject.type)) return { ok: false, reason: 'invalid' };
  return {
    ...read,
    fields: read.fields.filter((field) => characterWorkFields(release, read.public.subject.type).includes(field.id)),
  };
}
export function characterFacts(read: Extract<CharacterRead, { ok: true }>): EditorRead {
  return read.character
    ? { ok: true, public: read.character, release: read.release, source: null }
    : { ok: false, reason: 'invalid' };
}
export async function readCharacterProfile(
  client: KernelClient,
  address: CharacterAddress,
  locale = 'en',
): Promise<CharacterRead> {
  if ([address.id, address.work].some((id) => id !== undefined && !characterUuid.test(id)))
    return { ok: false, reason: 'invalid' };
  try {
    const [active, character, work] = await Promise.all([
      client.definitions.active.get(),
      address.id ? client.subjects({ id: address.id }).get() : undefined,
      address.work ? client.subjects({ id: address.work }).get() : undefined,
    ]);
    for (const [result, id] of [
      [character, address.id],
      [work, address.work],
    ] as const) {
      if (!id) continue;
      if (result?.status === 403 || result?.status === 404) return { ok: false, reason: 'denied' };
      if (result?.status === 308 || (result?.data && result.data.subject.id !== id))
        return { ok: false, reason: 'stale' };
      if (result?.status !== 200 || !result.data) return { ok: false, reason: 'unavailable' };
    }
    if (active.status !== 200 || !active.data) return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types?.[characterType] || !release.properties) return { ok: false, reason: 'unavailable' };
    const selectedType = work?.data ? await readTypeDescriptor(client, work.data.subject.type, locale) : undefined;
    if (selectedType && !selectedType.ok)
      return { ok: false, reason: selectedType.reason === 'missing' ? 'invalid' : 'unavailable' };
    const workDescriptor = selectedType?.ok ? selectedType.descriptor : null;
    if (
      (character?.data && character.data.subject.type !== characterType) ||
      (workDescriptor && !characterWork(characterWorkDefinitions(workDescriptor), workDescriptor.typeId))
    )
      return { ok: false, reason: 'invalid' };
    return { ok: true, release, character: character?.data ?? null, work: work?.data ?? null, workDescriptor };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
export function characterDraft(release: Release, terms: TermDraft[], facts: StatementInput[]) {
  const initial = initialTerms(characterType, terms);
  const item: CharacterItem = { ...initial.item, statements: {} };
  for (const fact of facts) (item.statements[fact.property.id] ??= []).push(structuredClone(fact));
  return { item, errors: [...initial.errors, ...validateCharacter(release, item)] };
}
export function validateCharacter(release: Release, item: CharacterItem): Violation[] {
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  if (item.type !== characterType) errors.push({ pointer: '/type', code: 'unsupported' });
  if (errors.length) return errors;
  // Native grouped statements are the only optional initial facts. Work credits cannot live on a character.
  for (const [property, statements] of Object.entries(item.statements)) {
    if (!release.types[characterType]?.properties.includes(property))
      errors.push({ pointer: `/statements/${property}`, code: 'unsupported' });
    if (statements.some((statement) => statement.property.id !== property))
      errors.push({ pointer: `/statements/${property}`, code: 'invalid_format' });
  }
  return errors;
}
export async function createCharacter(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: CharacterCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const current = await readCharacterProfile(client, {});
  if (!current.ok) return { ok: false, reason: 'unavailable' };
  const errors = validateCharacter(current.release, command.item);
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  return createSubjectRecord(client, request, env, command, locale, preparedAuthorization);
}
