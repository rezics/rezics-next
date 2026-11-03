import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { checkSubjectInput } from '@rezics/definitions/validate';
import type { SessionEnv } from '../../session/client';
import { createTypes, type InitialSubject } from './create-subject';
import { createSubjectRecord } from './create-subject-request';
import { episodeMembershipAdmission, screenSeriesId } from './screen-episode-membership';
import { creationStatement, editableScalar, type StatementInput } from './statement-editor';
import { catalogueEntries } from './catalogue-entry';
import {
  profileFields,
  profileLibraryControls,
  profileSourceRecords,
  type MusicReaderVisit,
  type ProfileBound,
  type ProfileGroup,
  type ProfileLibrary,
  type ProfileReaderState,
  type ProfileSourceRecord,
} from './music-reader';

export const screenTypes = ['schema:Movie', 'schema:TVSeries', 'schema:TVSeason', 'schema:Episode'] as const;
export function isScreenType(type: string): boolean {
  return screenTypes.some((id) => id === type);
}
export type ScreenAddress = { id?: string | undefined; series?: string | undefined };
export type ScreenRead =
  | { ok: false; reason: 'concealed' | 'invalid' | 'unavailable' }
  | {
      ok: true;
      release: Release;
      public: SubjectRead | null;
      series?: SubjectRead | null;
      seriesId?: string | undefined;
      seriesIssue?: 'concealed' | 'invalid' | 'unavailable' | undefined;
    };
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
export async function readScreenProfile(client: KernelClient, address: ScreenAddress = {}): Promise<ScreenRead> {
  const id = screenSeriesId(address.id);
  const seriesId = screenSeriesId(address.series);
  if (address.id && !id) return { ok: false, reason: 'invalid' };
  try {
    const [subject, active, series] = await Promise.all([
      id ? client.subjects({ id }).get() : undefined,
      client.definitions.active.get(),
      seriesId ? client.subjects({ id: seriesId }).get() : undefined,
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
    let seriesIssue: Extract<ScreenRead, { ok: true }>['seriesIssue'];
    let suggested: SubjectRead | null = null;
    if (seriesId) {
      if (!series || [403, 404].includes(series.status)) seriesIssue = 'concealed';
      else if (series.status === 308 || (series.data && series.data.subject.id !== seriesId)) seriesIssue = 'invalid';
      else if (series.status !== 200 || !series.data) seriesIssue = 'unavailable';
      else {
        suggested = series.data;
        if (!episodeMembershipAdmission(release, series.data.subject.type).seriesAdmitted) seriesIssue = 'invalid';
      }
    }
    return {
      ok: true,
      release,
      public: subject?.data ?? null,
      series: suggested,
      ...(seriesId ? { seriesId, seriesIssue } : {}),
    };
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

export type ScreenReaderVisit = {
  state: ProfileReaderState;
  type: string;
  grain: { text: string; lang: string | null };
  library: ProfileLibrary;
  unpublished: { tracks: false; episodes: true };
  groups: ProfileGroup[];
  sources: ProfileSourceRecord[];
  bounds: ProfileBound[];
  correction?: { id: string; href: string };
};

const screenIdentity = new Set([
  'schema:name',
  'schema:description',
  'schema:alternateName',
  'schema:sameAs',
  'rezics:representativeEdition',
]);

function screenReaderGroups(release: Release, type: string): Record<string, string[]> {
  const groups = screenGroups(release, type);
  return {
    dates: groups.dates,
    amounts: groups.amounts,
    credits: groups.credits,
    parts: groups.parts.filter((id) => !screenIdentity.has(id)),
    classification: groups.classification,
    text: groups.text.filter((id) => !screenIdentity.has(id)),
    authored: groups.authored,
  };
}

/** Ordinary Movie/TVSeries reader visit. Episode lists stay unpublished unless that exact subject is opened. */
export function screenReaderVisit(input: {
  locale: string;
  type?: string;
  release?: Release;
  public?: SubjectRead | null;
  reason?: Exclude<ProfileReaderState, 'ready' | 'empty'>;
  bounds?: readonly ProfileBound[];
  loading?: boolean;
}): ScreenReaderVisit {
  const type = input.public?.subject.type ?? input.type ?? 'schema:Movie';
  const bounds = [...(input.bounds ?? [])];
  const emptyLibrary: ProfileLibrary = { admitted: false, states: [], copies: false, progress: false };
  const unpublished = { tracks: false as const, episodes: true as const };
  if (input.loading) {
    return {
      state: 'loading',
      type,
      grain: { text: type, lang: null },
      library: emptyLibrary,
      unpublished,
      groups: [],
      sources: [],
      bounds,
    };
  }
  if (input.reason) {
    return {
      state: input.reason,
      type,
      grain: { text: type, lang: null },
      library: emptyLibrary,
      unpublished,
      groups: [],
      sources: [],
      bounds,
    };
  }
  const release = input.release;
  if (!release || !isScreenType(type) || !release.types[type]) {
    return {
      state: 'unavailable',
      type,
      grain: { text: type, lang: null },
      library: emptyLibrary,
      unpublished,
      groups: [],
      sources: input.public ? profileSourceRecords(input.public.subject) : [],
      bounds,
    };
  }
  const publicRead = input.public;
  if (publicRead && !isScreenType(publicRead.subject.type)) {
    return {
      state: 'invalid',
      type,
      grain: pickText(release.types[type]?.labels ?? {}, input.locale),
      library: emptyLibrary,
      unpublished,
      groups: [],
      sources: profileSourceRecords(publicRead.subject),
      bounds,
    };
  }
  const grain = pickText(release.types[type]?.labels ?? {}, input.locale);
  const library = profileLibraryControls(release, type);
  if (!publicRead) {
    return {
      state: 'empty',
      type,
      grain,
      library,
      unpublished,
      groups: [],
      sources: [],
      bounds,
    };
  }
  const groups = Object.entries(screenReaderGroups(release, publicRead.subject.type)).flatMap(([id, properties]) => {
    const fields = profileFields(release, publicRead, properties, input.locale);
    return fields.length ? [{ id, fields }] : [];
  });
  const title = pickText(publicRead.subject.labels, input.locale).text;
  return {
    state: groups.length || profileSourceRecords(publicRead.subject).length ? 'ready' : 'empty',
    type: publicRead.subject.type,
    grain,
    library,
    unpublished,
    groups,
    sources: profileSourceRecords(publicRead.subject),
    bounds,
    correction: {
      id: publicRead.subject.id,
      href: catalogueEntries.screen({ id: publicRead.subject.id, label: title, locale: input.locale }).href,
    },
  };
}

export type { MusicReaderVisit };
