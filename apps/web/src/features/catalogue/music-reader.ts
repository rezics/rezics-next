import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { libraryChoices, libraryProfile } from '../../library/profiles';
import { catalogueEntries } from './catalogue-entry';
import { albumFields, albumType } from './album-profile';
import { albumUuid } from './contract/album';
import type { GuideRelease } from './definition-guide';
import { isA } from './release-fidelity/model';
import { encodedBytes } from './release-fidelity/encoding';

export type ProfileReaderState =
  | 'ready'
  | 'empty'
  | 'loading'
  | 'unavailable'
  | 'denied'
  | 'concealed'
  | 'stale'
  | 'invalid';

export type ProfileSourceRecord = {
  name: string;
  url: string;
  licence?: { id: string; url?: string };
  attribution?: string;
};

export type ProfileFieldValue = {
  id: string;
  state: 'value' | 'unknown' | 'none';
  targetId?: string;
  targetLabel?: string;
  time?: string;
  precision?: number;
  text?: string;
  creditedAs?: string;
  roleLabel?: string;
  position?: string;
  episodeNumber?: string;
};

export type ProfileField = {
  property: string;
  label: { text: string; lang: string | null };
  values: ProfileFieldValue[];
};

export type ProfileGroup = { id: string; fields: ProfileField[] };

export type ProfileBound = {
  property: string;
  loaded: number;
  next?: string;
  complete: boolean;
};

export type ProfileLibrary = {
  admitted: boolean;
  profileId?: string;
  states: readonly string[];
  copies: boolean;
  progress: boolean;
};

type EditionLinks = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['links']['get']>>['data']>;
export const albumEditionProperty = 'schema:releaseOf';
export const albumEditionLimit = 20;
export type AlbumEditionAddress = { id: string; context: string; cursor?: string };
export type AlbumEditionRead =
  | { ok: false; reason: 'unavailable' | 'withheld' | 'invalid' }
  | {
      ok: true;
      admitted: boolean;
      rows: EditionLinks['links'];
      next: string | null;
      caughtUp: boolean;
    };

export type MusicReaderVisit = {
  state: ProfileReaderState;
  type: typeof albumType;
  grain: { text: string; lang: string | null };
  library: ProfileLibrary;
  unpublished: { tracks: true; library: true };
  groups: ProfileGroup[];
  sources: ProfileSourceRecord[];
  bounds: ProfileBound[];
  editions: AlbumEditionRead;
  correction?: { id: string; href: string };
};

const skipped = new Set([
  'schema:name',
  'schema:description',
  'schema:alternateName',
  'schema:image',
  'schema:sameAs',
  'rezics:representativeEdition',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statementList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function qualifierContent(statement: Record<string, unknown>, property: string): unknown {
  const qualifiers = Array.isArray(statement.qualifiers) ? statement.qualifiers : [];
  for (const qualifier of qualifiers) {
    if (!isRecord(qualifier) || !isRecord(qualifier.property) || qualifier.property.id !== property) continue;
    if (!isRecord(qualifier.value)) continue;
    if (qualifier.value.type === 'value') return qualifier.value.content;
  }
  return;
}

/** Native source provenance from the current subject read, never editorial acceptance. */
export function profileSourceRecords(subject: unknown): ProfileSourceRecord[] {
  if (!isRecord(subject) || !Array.isArray(subject.sourceRecords)) return [];
  return subject.sourceRecords.flatMap((record) => {
    if (!isRecord(record) || typeof record.name !== 'string' || typeof record.url !== 'string') return [];
    const licenceId = isRecord(record.licence) && typeof record.licence.id === 'string' ? record.licence.id : undefined;
    const licenceUrl =
      isRecord(record.licence) && typeof record.licence.url === 'string' ? record.licence.url : undefined;
    return [
      {
        name: record.name,
        url: record.url,
        ...(licenceId
          ? {
              licence: {
                id: licenceId,
                ...(licenceUrl ? { url: licenceUrl } : {}),
              },
            }
          : {}),
        ...(typeof record.attribution === 'string' ? { attribution: record.attribution } : {}),
      },
    ];
  });
}

/** Library controls exist only when the exact released type names a registered profile. */
export function profileLibraryControls(release: Release, type: string): ProfileLibrary {
  const profile = libraryProfile(release as Parameters<typeof libraryProfile>[0], type);
  const choices = libraryChoices(release as Parameters<typeof libraryChoices>[0], type);
  return {
    admitted: !!profile,
    ...(profile ? { profileId: profile.id } : {}),
    states: choices?.states.map((state) => state.id) ?? [],
    copies: (choices?.copyKinds.length ?? 0) > 0,
    progress: (choices?.progress.length ?? 0) > 0,
  };
}

export function profileFieldLabel(
  release: Release,
  property: string,
  locale: string,
  related?: SubjectRead['related'],
) {
  const fromRelease = pickText(release.properties[property]?.labels ?? {}, locale);
  if (fromRelease.text) return fromRelease;
  const fromRelated = pickText(related?.[property]?.labels ?? {}, locale);
  return fromRelated.text ? fromRelated : { text: property, lang: null };
}

export function profileFieldValue(
  statement: Record<string, unknown>,
  related: SubjectRead['related'] | undefined,
  locale: string,
): ProfileFieldValue | undefined {
  const id = typeof statement.id === 'string' ? statement.id : undefined;
  const value = isRecord(statement.value) ? statement.value : undefined;
  if (!id || !value) return;
  if (value.type === 'somevalue') return { id, state: 'unknown' };
  if (value.type === 'novalue') return { id, state: 'none' };
  if (value.type !== 'value') return;
  const creditedAs = qualifierContent(statement, 'wdt:P1932');
  const roleId = qualifierContent(statement, 'wdt:P3831');
  const position = qualifierContent(statement, 'schema:position');
  const episodeNumber = qualifierContent(statement, 'schema:episodeNumber');
  const roleLabel = typeof roleId === 'string' ? pickText(related?.[roleId]?.labels ?? {}, locale).text : '';
  const credit = {
    ...(typeof creditedAs === 'string' && creditedAs ? { creditedAs } : {}),
    ...(roleLabel ? { roleLabel } : {}),
    ...(typeof position === 'string' ? { position } : {}),
  };
  const extras = {
    ...(credit.creditedAs || credit.roleLabel || credit.position ? credit : {}),
    ...(typeof episodeNumber === 'string' ? { episodeNumber } : {}),
  };
  const content = value.content;
  if (typeof content === 'string') {
    const targetLabel = pickText(related?.[content]?.labels ?? {}, locale).text;
    return {
      id,
      state: 'value',
      targetId: content,
      ...(targetLabel ? { targetLabel } : {}),
      ...extras,
    };
  }
  if (isRecord(content) && typeof content.time === 'string') {
    return {
      id,
      state: 'value',
      time: content.time,
      ...(typeof content.precision === 'number' ? { precision: content.precision } : {}),
      ...extras,
    };
  }
  if (isRecord(content) && typeof content.text === 'string') {
    return { id, state: 'value', text: content.text, ...extras };
  }
  if (typeof content === 'number' || typeof content === 'boolean') {
    return { id, state: 'value', text: String(content), ...extras };
  }
  return { id, state: 'value', ...extras };
}

/** Composed subject page body as the ordinary current-authority reader. */
export function composedSubjectRead(read: {
  subject: SubjectRead['subject'];
  related: SubjectRead['related'];
  account?: SubjectRead['account'];
  summary?: SubjectRead['summary'] | null;
}): SubjectRead {
  return {
    subject: read.subject,
    related: read.related,
    account: read.account ?? null,
    summary: read.summary ?? null,
  };
}

export function profileFields(
  release: Release,
  publicRead: SubjectRead,
  properties: readonly string[],
  locale: string,
): ProfileField[] {
  return properties.flatMap((property) => {
    const values = statementList(publicRead.subject.statements[property]).flatMap((statement) => {
      const value = profileFieldValue(statement, publicRead.related, locale);
      return value ? [value] : [];
    });
    if (!values.length) return [];
    return [{ property, label: profileFieldLabel(release, property, locale, publicRead.related), values }];
  });
}

/** Inverse schema:releaseOf is admitted when the album is a declared target of a released MusicRelease. */
export function albumEditionsAdmitted(release: Pick<Release, 'types' | 'properties'>): boolean {
  const relation = release.properties[albumEditionProperty];
  return (
    !!release.types[albumType] &&
    !!relation?.relation?.inverse &&
    relation.relation.inverse !== 'none' &&
    !!relation.targets?.some((target) => isA(release, albumType, target)) &&
    Object.keys(release.types).some(
      (type) =>
        isA(release, type, 'schema:MusicRelease') && release.types[type]?.properties.includes(albumEditionProperty),
    )
  );
}

export function validAlbumEditionAddress(address: AlbumEditionAddress): boolean {
  return (
    !!address &&
    albumUuid.test(address.id) &&
    albumUuid.test(address.context) &&
    (address.cursor === undefined ||
      (typeof address.cursor === 'string' && address.cursor.length > 0 && address.cursor.length <= 4096))
  );
}

const editionFailure = (status: number): AlbumEditionRead => ({
  ok: false,
  reason: [403, 404, 308].includes(status) ? 'withheld' : 'unavailable',
});

/** One 20-row inverse edition window. No target hydration, refill or provider calls. */
export async function readAlbumEditions(
  client: KernelClient,
  definitions: GuideRelease | Promise<GuideRelease>,
  address: AlbumEditionAddress,
  locale: string,
): Promise<AlbumEditionRead> {
  if (!validAlbumEditionAddress(address)) return { ok: false, reason: 'invalid' };
  try {
    const [current, release] = await Promise.all([
      client.subjects({ id: address.id }).get({ query: { context: address.context, language: locale } }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return editionFailure(current.status);
    if (
      current.data.subject.id !== address.id ||
      current.data.subject.context !== address.context ||
      current.data.subject.type !== albumType
    )
      return { ok: false, reason: 'withheld' };
    const admitted = albumEditionsAdmitted(release);
    if (address.cursor && !admitted) return { ok: false, reason: 'invalid' };
    if (!admitted) return { ok: true, admitted: false, rows: [], next: null, caughtUp: true };
    const response = await client.subjects({ id: address.id }).links.get({
      query: {
        property: albumEditionProperty,
        context: address.context,
        language: locale,
        limit: albumEditionLimit,
        ...(address.cursor ? { cursor: address.cursor } : {}),
      },
    });
    if (response.status !== 200 || !response.data) return editionFailure(response.status);
    const page = response.data;
    if (
      page.links.length > albumEditionLimit ||
      encodedBytes(page) > albumEditionLimit * 128 * 1024 + 64 * 1024 ||
      (page.next !== null &&
        (typeof page.next !== 'string' || !page.next.length || page.next.length > 4096 || page.next === address.cursor))
    )
      return { ok: false, reason: 'unavailable' };
    const seen = new Set<string>();
    for (const row of page.links) {
      const key = `${row.subject}:${row.statement}`;
      if (
        encodedBytes(row) > 128 * 1024 ||
        seen.has(key) ||
        !albumUuid.test(row.subject) ||
        !albumUuid.test(row.statement) ||
        row.property !== albumEditionProperty ||
        (row.summary && row.summary.id !== row.subject) ||
        (row.assertion &&
          (row.assertion.id !== row.statement ||
            row.assertion.property.id !== albumEditionProperty ||
            row.assertion.value.type !== 'value' ||
            row.assertion.value.content !== address.id))
      )
        return { ok: false, reason: 'unavailable' };
      seen.add(key);
    }
    return { ok: true, admitted: true, rows: page.links, next: page.next, caughtUp: page.freshness.caught_up };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function emptyEditions(release?: Release): Extract<AlbumEditionRead, { ok: true }> {
  return { ok: true, admitted: !!release && albumEditionsAdmitted(release), rows: [], next: null, caughtUp: true };
}

function musicGroups(release: Release): Record<string, string[]> {
  const fields = albumFields(release);
  const credits = fields.relations.filter((id) => release.properties[id]?.relation?.group === 'credit');
  return {
    dates: fields.scalar.filter((id) => release.properties[id]?.datatype === 'time'),
    details: fields.scalar.filter((id) => release.properties[id]?.datatype !== 'time' && !skipped.has(id)),
    credits,
    related: fields.relations.filter((id) => !credits.includes(id)),
    classification: fields.classifications,
    authored: fields.authored,
  };
}

export function musicReaderVisit(input: {
  locale: string;
  release?: Release;
  public?: SubjectRead | null;
  reason?: Exclude<ProfileReaderState, 'ready' | 'empty'>;
  bounds?: readonly ProfileBound[];
  editions?: AlbumEditionRead;
  loading?: boolean;
}): MusicReaderVisit {
  const library: ProfileLibrary = { admitted: false, states: [], copies: false, progress: false };
  const unpublished = { tracks: true as const, library: true as const };
  const editions = input.editions ?? emptyEditions(input.release);
  const bounds = [
    ...(input.bounds ?? []),
    ...(editions.ok && editions.admitted
      ? [
          {
            property: albumEditionProperty,
            loaded: editions.rows.length,
            complete: editions.next === null,
            ...(editions.next ? { next: editions.next } : {}),
          },
        ]
      : []),
  ];
  if (input.loading) {
    return {
      state: 'loading',
      type: albumType,
      grain: { text: albumType, lang: null },
      library,
      unpublished,
      groups: [],
      sources: [],
      bounds,
      editions,
    };
  }
  if (input.reason) {
    return {
      state: input.reason,
      type: albumType,
      grain: { text: albumType, lang: null },
      library,
      unpublished,
      groups: [],
      sources: [],
      bounds,
      editions,
    };
  }
  const release = input.release;
  const publicRead = input.public;
  if (!release || !release.types[albumType]) {
    return {
      state: 'unavailable',
      type: albumType,
      grain: { text: albumType, lang: null },
      library,
      unpublished,
      groups: [],
      sources: publicRead ? profileSourceRecords(publicRead.subject) : [],
      bounds,
      editions,
    };
  }
  if (publicRead && publicRead.subject.type !== albumType) {
    return {
      state: 'invalid',
      type: albumType,
      grain: pickText(release.types[albumType]?.labels ?? {}, input.locale),
      library,
      unpublished,
      groups: [],
      sources: profileSourceRecords(publicRead.subject),
      bounds,
      editions,
    };
  }
  const grain = pickText(release.types[albumType]?.labels ?? {}, input.locale);
  if (!publicRead) {
    return {
      state: 'empty',
      type: albumType,
      grain,
      library,
      unpublished,
      groups: [],
      sources: [],
      bounds,
      editions,
    };
  }
  const grouped = musicGroups(release);
  const groups = Object.entries(grouped).flatMap(([id, properties]) => {
    const fields = profileFields(release, publicRead, properties, input.locale);
    return fields.length ? [{ id, fields }] : [];
  });
  const title = pickText(publicRead.subject.labels, input.locale).text;
  return {
    state: groups.length || profileSourceRecords(publicRead.subject).length ? 'ready' : 'empty',
    type: albumType,
    grain,
    library,
    unpublished,
    groups,
    sources: profileSourceRecords(publicRead.subject),
    bounds,
    editions,
    correction: {
      id: publicRead.subject.id,
      href: catalogueEntries.album({ id: publicRead.subject.id, label: title, locale: input.locale }).href,
    },
  };
}
