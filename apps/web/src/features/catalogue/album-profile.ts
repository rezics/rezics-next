import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { candidateFailure } from '../../subject/candidates';
import { relationFields } from '../../subject/relation-candidates';
import { initialTerms, type CreateResult, type InitialSubject, type TermDraft } from './create-subject';
import type { CreateAuthority } from './identity-intake';
import { createSubjectRecord } from './create-subject-request';
import { correctionProperty, type StatementInput } from './statement-editor';
import type { EditorRead } from './statement-editor';

export const albumType = 'schema:MusicAlbum';
export const albumUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type AlbumItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type AlbumCommand = { item: AlbumItem; key: string };
export type AlbumRead =
  | { ok: false; reason: 'concealed' | 'denied' | 'invalid' | 'stale' | 'unavailable' }
  | {
      ok: true;
      release: Release;
      public: SubjectRead | null;
      /** Present only after a deliberate public-origin Global correction choice. */
      correction?: Extract<EditorRead, { ok: true }>;
    };
export type AlbumTransport = {
  load: () => Promise<AlbumRead>;
  create: (command: AlbumCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<import('./create-subject').CreatedReader>;
  /** Current Global Context subject.create observation. Independent of edition reading. */
  eligibility?: () => Promise<CreateAuthority>;
};

/** Presentation only: the effective immutable release decides which controls exist. */
export function albumFields(release: Release) {
  const effective = release.types[albumType]?.properties ?? [];
  const named = effective.filter(
    (id) => !!release.properties[id] && !!pickText(release.properties[id]!.labels, 'en').text,
  );
  return {
    scalar: named.filter((id) => correctionProperty(release, albumType, id)),
    relations: relationFields(release, albumType, 'en').map((field) => field.id),
    classifications: named.filter((id) => release.properties[id]!.relation?.group === 'classification'),
    authored: named.filter((id) => release.properties[id]!.datatype === 'document'),
  };
}

export function albumTarget(release: Release, property: string, types: readonly string[]): boolean {
  return types.some((type) =>
    release.properties[property]?.targets?.some((base) => type === base || release.types[type]?.bases.includes(base)),
  );
}

export async function readAlbumProfile(client: KernelClient, id?: string): Promise<AlbumRead> {
  if (id !== undefined && !albumUuid.test(id)) return { ok: false, reason: 'concealed' };
  try {
    const [subject, active] = await Promise.all([
      id ? client.subjects({ id }).get() : undefined,
      client.definitions.active.get(),
    ]);
    if (subject && (subject.status === 403 || subject.status === 404 || subject.status === 308))
      return { ok: false, reason: 'concealed' };
    if (subject && (subject.status !== 200 || !subject.data)) return candidateFailure(subject.status);
    if (subject?.data && subject.data.subject.id !== id) return { ok: false, reason: 'stale' };
    if (subject?.data && subject.data.subject.type !== albumType) return { ok: false, reason: 'invalid' };
    if (active.status !== 200 || !active.data) return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    return { ok: true, release, public: subject?.data ?? null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Native validation, without a second profile schema or ingestion Source envelope. */
export function validateAlbum(release: Release, item: AlbumItem): Violation[] {
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  if (item.type !== albumType) errors.push({ pointer: '/type', code: 'unsupported' });
  if (errors.length) return errors;
  const fields = albumFields(release);
  const admitted = [...fields.scalar, ...fields.relations, ...fields.classifications];
  for (const [id, statements] of Object.entries(item.statements ?? {})) {
    if (!admitted.includes(id)) errors.push({ pointer: `/statements/${id}`, code: 'unsupported' });
    for (const statement of statements) {
      if (statement.property.id !== id) errors.push({ pointer: `/statements/${id}`, code: 'invalid_format' });
    }
  }
  return errors;
}

export function albumDraft(release: Release, terms: TermDraft[], statements: StatementInput[]) {
  const initial = initialTerms(albumType, terms);
  const item: AlbumItem = { ...initial.item, statements: {} };
  for (const statement of statements) (item.statements[statement.property.id] ??= []).push(structuredClone(statement));
  return { item, errors: [...initial.errors, ...validateAlbum(release, item)] };
}

export async function createAlbum(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: AlbumCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  if (command.item.type !== albumType) return { ok: false, reason: 'invalid' };
  // The native writer validates current definitions and owns receipt replay. A new release must not
  // prevent retrying an uncertain command that the native writer may already have committed.
  return createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
}
