import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import type { CreateResult, InitialSubject } from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import { editableScalar, type StatementInput } from './statement-editor';

export const gameTypes = ['schema:VideoGame', 'wd:Q689445', 'wd:Q209163', 'wd:Q20631656'] as const;
export const gameUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type GameItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type GameCommand = { item: GameItem; key: string };
export type GameRead =
  | { ok: false; reason: 'denied' | 'invalid' | 'stale' | 'unavailable' }
  | { ok: true; release: Release; public: SubjectRead | null };
export type GameGroup = 'credits' | 'classification' | 'relations' | 'facts';
const terms = new Set(['schema:name', 'schema:alternateName', 'schema:description']);

/** Only actual released work identities and the two explicitly admitted separate grains. */
export function gameType(release: Release, type: string): boolean {
  return (
    !!release.types[type] &&
    (gameTypes.includes(type as (typeof gameTypes)[number]) || release.types[type]!.bases.includes('schema:VideoGame'))
  );
}
export function gameFields(release: Release, type: string): string[] {
  if (!gameType(release, type)) return [];
  return release.types[type]!.properties.filter((id) => {
    const property = release.properties[id];
    return (
      !terms.has(id) &&
      !!property &&
      ((property.datatype === 'wikibase-item' && !!property.relation) || editableScalar(property))
    );
  });
}
export function gameGroups(release: Release, type: string): Record<GameGroup, string[]> {
  const groups: Record<GameGroup, string[]> = { credits: [], classification: [], relations: [], facts: [] };
  for (const id of gameFields(release, type)) {
    const relation = release.properties[id]!.relation;
    groups[
      relation?.group === 'credit'
        ? 'credits'
        : relation?.group === 'classification'
          ? 'classification'
          : relation
            ? 'relations'
            : 'facts'
    ].push(id);
  }
  return groups;
}
export function gameTarget(release: Pick<Release, 'properties' | 'types'>, property: string, type: string) {
  return (
    release.properties[property]?.targets?.some(
      (base) => base === type || release.types[type]?.bases.includes(base),
    ) === true
  );
}
export async function readGameProfile(client: KernelClient, id?: string): Promise<GameRead> {
  if (id !== undefined && !gameUuid.test(id)) return { ok: false, reason: 'denied' };
  try {
    const [subject, active] = await Promise.all([
      id ? client.subjects({ id }).get() : undefined,
      client.definitions.active.get(),
    ]);
    if (subject && [403, 404, 308].includes(subject.status)) return { ok: false, reason: 'denied' };
    if ((id && (subject?.status !== 200 || !subject.data)) || active.status !== 200 || !active.data)
      return { ok: false, reason: 'unavailable' };
    if (subject?.data && subject.data.subject.id !== id) return { ok: false, reason: 'stale' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    if (subject?.data && !gameType(release, subject.data.subject.type)) return { ok: false, reason: 'invalid' };
    return { ok: true, release, public: subject?.data ?? null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Native validation owns values, cardinalities, qualifiers, references, units and emitted constraints. */
export function gameDraft(release: Release, initial: InitialSubject, statements: StatementInput[]) {
  const item: GameItem = { ...initial, statements: {} };
  for (const statement of statements) (item.statements[statement.property.id] ??= []).push(structuredClone(statement));
  const errors: Violation[] = checkSubjectInput(item, release).violations;
  if (!gameType(release, item.type)) errors.push({ pointer: '/type', code: 'unsupported' });
  const fields = gameFields(release, item.type);
  for (const id of Object.keys(item.statements))
    if (!fields.includes(id)) errors.push({ pointer: `/statements/${id}`, code: 'unsupported' });
  return { item, errors };
}
export async function createGameProfile(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: GameCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const read = await readGameProfile(client);
  if (!read.ok) return { ok: false, reason: 'unavailable' };
  const draft = gameDraft(read.release, command.item, Object.values(command.item.statements).flat());
  // Keep the exact supplied map, including rejecting disguised property keys.
  if (
    Object.entries(command.item.statements).some(([id, entries]) => entries.some((entry) => entry.property.id !== id))
  )
    draft.errors.push({ pointer: '/statements', code: 'invalid_format' });
  if (draft.errors.length) return { ok: false, reason: 'invalid', errors: draft.errors, refreshDefinitions: true };
  return createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
}
export function gameDefinitions(release: Release, locale: string) {
  return Object.entries(release.types).flatMap(([id, type]) => {
    const label = pickText(type.labels, locale);
    const description = pickText(type.descriptions ?? {}, locale);
    if (!gameType(release, id) || !label.text) return [];
    const bases = type.bases.filter((base) => typeof base === 'string' && base.length > 0);
    return [
      {
        id,
        label: label.text,
        description: description.text,
        ...(label.lang ? { labelLanguage: label.lang } : {}),
        ...(description.lang ? { descriptionLanguage: description.lang } : {}),
        ...(bases.length ? { bases } : {}),
      },
    ];
  });
}
