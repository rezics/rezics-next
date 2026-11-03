import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { createSubjectRecord } from './create-subject-request';
import {
  initialTerms,
  type CreateResult,
  type CreatedReader,
  type InitialSubject,
  type TermDraft,
} from './create-subject';
import { creationStatement, editableScalar, emptyCreationStatement, type StatementInput } from './statement-editor';
import { definitionText } from './definition-guide';

export type PublicationItem = InitialSubject & { statements: Record<string, StatementInput[]> };
export type PublicationCommand = { work: string; relation: string; item: PublicationItem; key: string };
export type PublicationRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'unavailable' }
  | { ok: true; public: SubjectRead; release: Release; source: null; profiles: PublicationProfile[] };
export type PublicationProfile = {
  id: string;
  label: string;
  labelLang: string | null;
  description: string;
  descriptionLang: string | null;
  relations: string[];
  fields: string[];
};
export type PublicationTransport = {
  load: (refresh?: boolean) => Promise<PublicationRead>;
  submit: (command: PublicationCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
};
export const publicationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicationTypes = new Set(['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656']);
const fields = [
  'schema:isbn',
  'schema:gtin',
  'schema:datePublished',
  'schema:publisher',
  'schema:inLanguage',
  'schema:numberOfPages',
];
const videoWorks = ['schema:Movie', 'schema:TVSeries', 'schema:TVSeason', 'schema:Episode'];

function isA(release: Release, type: string, base: string) {
  return type === base || release.types[type]?.bases.includes(base) === true;
}
export function publicationTarget(release: Release, type: string, property: string): boolean {
  return release.properties[property]?.targets?.some((base) => isA(release, type, base)) === true;
}

/** Only the released work/publication grains, with effective emitted fields and native target meanings. */
export function publicationProfiles(release: Release, workType: string, locale: string): PublicationProfile[] {
  if (!release.types[workType] || publicationTypes.has(workType)) return [];
  const profile = isA(release, workType, 'schema:Book')
    ? 'bf:Instance'
    : videoWorks.some((type) => isA(release, workType, type))
      ? 'rezics:AnimeRelease'
      : isA(release, workType, 'schema:VideoGame') || isA(release, workType, 'schema:SoftwareApplication')
        ? 'wd:Q20631656'
        : undefined;
  const definition = profile ? release.types[profile] : undefined;
  if (!profile || !definition) return [];
  const label = definitionText(definition.labels, locale);
  const description = definitionText(definition.descriptions, locale);
  const relations = ['schema:exampleOfWork', ...(profile === 'rezics:AnimeRelease' ? ['bf:hasPart'] : [])].filter(
    (id) =>
      definition.properties.includes(id) &&
      !!release.properties[id]?.relation &&
      publicationTarget(release, workType, id),
  );
  if (!label.text || !relations.length) return [];
  return [
    {
      id: profile,
      label: label.text,
      labelLang: label.lang,
      description: description.text,
      descriptionLang: description.lang,
      relations,
      fields: fields.filter(
        (id) =>
          definition.properties.includes(id) &&
          !!pickText(release.properties[id]?.labels ?? {}, locale).text &&
          ((id === 'schema:publisher' && !!release.properties[id]?.relation) || editableScalar(release.properties[id])),
      ),
    },
  ];
}

export async function readPublicationEditor(
  client: KernelClient,
  work: string,
  locale: string,
): Promise<PublicationRead> {
  if (!publicationUuid.test(work)) return { ok: false, reason: 'invalid' };
  try {
    const [subject, active] = await Promise.all([client.subjects({ id: work }).get(), client.definitions.active.get()]);
    if (subject.status === 403 || subject.status === 404) return { ok: false, reason: 'concealed' };
    if (
      subject.status !== 200 ||
      !subject.data ||
      subject.data.subject.id !== work ||
      active.status !== 200 ||
      !active.data
    )
      return { ok: false, reason: 'unavailable' };
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
      return { ok: false, reason: 'unavailable' };
    const release = bundle.data.release as Release;
    if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
    return {
      ok: true,
      public: subject.data,
      release,
      source: null,
      profiles: publicationProfiles(release, subject.data.subject.type, locale),
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function meaningful(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (typeof content === 'number' || typeof content === 'boolean') return true;
  if (Array.isArray(content)) return content.some(meaningful);
  if (content && typeof content === 'object')
    return Object.entries(content).some(
      ([key, value]) => !['unit', 'precision', 'calendarmodel', 'language'].includes(key) && meaningful(value),
    );
  return false;
}

/** Empty scaffolds are omitted; typed zero, false, no-value and some-value remain assertions. */
export function publicationAssertion(statement: StatementInput): boolean {
  if (statement.value.type !== 'value') return true;
  return (
    meaningful(statement.value.content) || (statement.qualifiers?.length ?? 0) > 0 || statement.references.length > 0
  );
}

export function publicationWorkStatement(relation: string, work: string, release: Release): StatementInput {
  return {
    ...emptyCreationStatement(relation, release),
    value: { type: 'value', content: work },
    rank: 'normal',
  };
}

export function publicationDraft(
  read: Extract<PublicationRead, { ok: true }>,
  type: string,
  relation: string,
  terms: TermDraft[],
  workLink: StatementInput,
  facts: StatementInput[],
  independent: boolean,
): { item: PublicationItem; errors: Violation[] } {
  const initial = initialTerms(type, terms);
  const link = creationStatement(
    {
      ...workLink,
      property: { id: relation },
      value: { type: 'value', content: read.public.subject.id },
      rank: 'normal',
    },
    read.release,
  );
  const statements: PublicationItem['statements'] = { [relation]: [link] };
  for (const fact of facts) {
    if (fact.property.id === relation) continue;
    const prepared = creationStatement({ ...fact, rank: 'normal' }, read.release);
    if (!publicationAssertion(prepared)) continue;
    (statements[prepared.property.id] ??= []).push(prepared);
  }
  const item: PublicationItem = { ...initial.item, statements };
  const errors = [...initial.errors, ...validatePublication(read, item, relation)];
  if (!independent) errors.push({ pointer: '/independent', code: 'required' });
  return { item, errors };
}

function validatePublication(
  read: Extract<PublicationRead, { ok: true }>,
  item: PublicationItem,
  relation: string,
): Violation[] {
  const errors = checkSubjectInput(item, read.release).violations;
  if (errors.length) return errors;
  const profile = read.profiles.find((entry) => entry.id === item.type);
  if (!profile) errors.push({ pointer: '/type', code: 'unsupported' });
  if (!profile?.relations.includes(relation)) errors.push({ pointer: '/relation', code: 'unsupported' });
  const link = item.statements?.[relation];
  if (link?.length !== 1 || link[0]?.value.type !== 'value' || link[0].value.content !== read.public.subject.id)
    errors.push({ pointer: '/relation', code: 'invalid_format' });
  for (const property of Object.keys(item.statements ?? {})) {
    if (property !== relation && !profile?.fields.includes(property))
      errors.push({ pointer: `/statements/${property}`, code: 'unsupported' });
  }
  return errors;
}

/** Re-read the exact real work and current release; native creation owns current authorization and selected facts. */
export async function createPublication(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: PublicationCommand,
  locale: string,
  preparedAuthorization?: string,
): Promise<CreateResult> {
  const read = await readPublicationEditor(client, command.work, locale);
  if (!read.ok) return { ok: false, reason: read.reason === 'invalid' ? 'invalid' : 'unavailable' };
  const errors = validatePublication(read, command.item, command.relation);
  if (errors.length) return { ok: false, reason: 'invalid', errors, refreshDefinitions: true };
  return createSubjectRecord(client, request, sessionEnv, command, locale, preparedAuthorization);
}
