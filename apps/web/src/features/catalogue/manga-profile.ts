import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import { pickText } from '@rezics/composition';
import type { SessionEnv } from '../../session/client';
import {
  initialTerms,
  type CreateResult,
  type CreatedReader,
  type InitialSubject,
  type TermDraft,
} from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import { editableScalar, type StatementInput } from './statement-editor';
import { validateAuthored } from './authored-field';

export const mangaTypes = ['schema:ComicSeries', 'schema:PublicationVolume'] as const;
export type MangaType = (typeof mangaTypes)[number];
export const isMangaType = (type: string): type is MangaType => mangaTypes.some((id) => id === type);
export const mangaUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MangaItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type MangaCommand = { key: string; item: MangaItem; independent: boolean };
export type MangaRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'unavailable' }
  | { ok: true; release: Release; releaseDigest: string; public: SubjectRead | null };
export type MangaTransport = {
  load: () => Promise<MangaRead>;
  /** Current parent subject.create observation; missing or malformed data never admits a write. */
  eligibility?: () => Promise<import('./identity-intake').CreateAuthority>;
  create: (command: MangaCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
};

// Presentation groups select from effective emitted fields; they never extend native admission.
const groups = {
  membership: ['wdt:P179', 'wdt:P1433'],
  creators: ['schema:author', 'schema:illustrator', 'schema:contributor', 'schema:publisher'],
  publication: [
    'schema:datePublished',
    'schema:inLanguage',
    'schema:isbn',
    'wdt:P5732',
    'schema:numberOfPages',
    'wdt:P2635',
  ],
  classification: ['schema:genre', 'schema:keywords'],
  writing: ['schema:abstract'],
};
export type MangaGroup = keyof typeof groups;
export function mangaGroups(release: Release, type: string, locale: string) {
  return Object.fromEntries(
    Object.entries(groups).map(([group, fields]) => [
      group,
      fields.filter((id) => {
        const property = release.properties[id];
        return (
          isMangaType(type) &&
          release.types[type]?.properties.includes(id) &&
          !!property &&
          !!pickText(property.labels, locale).text &&
          (property.datatype === 'document' ||
            (property.datatype === 'wikibase-item' && !!property.relation && !!property.targets?.length) ||
            editableScalar(property))
        );
      }),
    ]),
  ) as Record<MangaGroup, string[]>;
}
export function mangaFields(release: Release, type: string, locale: string) {
  return Object.values(mangaGroups(release, type, locale)).flat();
}
export function mangaTarget(release: Release, property: string, type: string) {
  return (
    release.properties[property]?.targets?.some(
      (base) => type === base || release.types[type]?.bases.includes(base),
    ) === true
  );
}
export const blankMangaStatement = (property: string): StatementInput => ({
  property: { id: property },
  value: { type: 'value', content: '' },
  qualifiers: [],
  references: [],
  rank: 'normal',
});

/** Subject and active-release discovery begin together, without per-field hydration. */
export async function readMangaProfile(client: KernelClient, id?: string): Promise<MangaRead> {
  if (id !== undefined && !mangaUuid.test(id)) return { ok: false, reason: 'concealed' };
  try {
    const [subject, active] = await Promise.all([
      id ? client.subjects({ id }).get() : undefined,
      client.definitions.active.get(),
    ]);
    if (subject && [403, 404, 308].includes(subject.status)) return { ok: false, reason: 'concealed' };
    if ((id && (subject?.status !== 200 || subject.data?.subject.id !== id)) || active.status !== 200 || !active.data)
      return { ok: false, reason: 'unavailable' };
    if (subject?.data && !isMangaType(subject.data.subject.type)) return { ok: false, reason: 'invalid' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    return { ok: true, release, releaseDigest: bundle.data.digest, public: subject?.data ?? null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export function validateManga(release: Release, item: MangaItem, locale: string): Violation[] {
  const errors = checkSubjectInput(item, release, undefined, true).violations;
  if (!isMangaType(item.type)) errors.push({ pointer: '/type', code: 'unsupported' });
  const fields = mangaFields(release, item.type, locale);
  for (const [property, statements] of Object.entries(item.statements ?? {})) {
    if (!fields.includes(property)) errors.push({ pointer: `/statements/${property}`, code: 'unsupported' });
    for (const [index, statement] of statements.entries()) {
      if (statement.property.id !== property)
        errors.push({ pointer: `/statements/${property}`, code: 'invalid_format' });
      if (release.properties[property]?.datatype === 'document')
        errors.push(
          ...validateAuthored(statement, release).map((error) => ({
            ...error,
            pointer: error.pointer.replace('/statement', `/statements/${property}/${index}`),
          })),
        );
    }
  }
  if (item.type === 'schema:PublicationVolume') {
    const work = item.statements['wdt:P179'];
    if (
      work?.length !== 1 ||
      work[0]?.value.type !== 'value' ||
      typeof work[0].value.content !== 'string' ||
      !mangaUuid.test(work[0].value.content)
    )
      errors.push({ pointer: '/statements/wdt:P179', code: 'required' });
  }
  return errors;
}
export function mangaDraft(
  release: Release,
  type: string,
  locale: string,
  terms: TermDraft[],
  statements: StatementInput[],
) {
  const initial = initialTerms(type, terms);
  const item: MangaItem = { ...initial.item, statements: {} };
  for (const statement of statements) (item.statements[statement.property.id] ??= []).push(structuredClone(statement));
  return { item, errors: [...initial.errors, ...validateManga(release, item, locale)] };
}

/** Native POST creates selected initial facts; only its returned identity supplies the current reader. */
export async function createManga(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: MangaCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const read = await readMangaProfile(client);
  if (!read.ok) return { ok: false, reason: 'unavailable' };
  const errors = validateManga(read.release, command.item, locale);
  if (command.item.type === 'schema:PublicationVolume' && !command.independent)
    errors.push({ pointer: '/independent', code: 'required' });
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  if (command.item.type === 'schema:PublicationVolume') {
    const value = command.item.statements['wdt:P179']![0]!.value;
    if (value.type !== 'value' || typeof value.content !== 'string') return { ok: false, reason: 'invalid' };
    const work = await readMangaProfile(client, value.content);
    if (!work.ok || !work.public) return { ok: false, reason: 'unavailable' };
    if (
      work.public.subject.type !== 'schema:ComicSeries' ||
      !mangaTarget(read.release, 'wdt:P179', work.public.subject.type)
    )
      return { ok: false, reason: 'invalid' };
  }
  return createSubjectRecord(client, request, env, command, locale, preparedAuthorization);
}
