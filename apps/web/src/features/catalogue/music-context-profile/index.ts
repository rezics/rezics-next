import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { candidateContext, candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import { isExploreId, MUSIC_CONTEXT_PAGE_CAP, typeExtends } from '../../pages/graph-browser';
import { relationFields, type RelationField } from '../../../subject/relation-candidates';
import { timePresentation, type TimePresentation } from '../../../subject/time-presentation';
import { isMusicContextCursor, isMusicContextStream } from './navigation';

export const musicContextRequested = {
  place: ['schema:Place', 'schema:MusicVenue'] as const,
  event: ['schema:Event', 'schema:MusicEvent'] as const,
  area: ['schema:AdministrativeArea'] as const,
  instrument: ['wd:Q34379'] as const,
} as const;

export type MusicContextKind = 'place' | 'event' | 'area' | 'instrument' | 'unsupported';
export type MusicContextFact = {
  property: string;
  label: string;
  text: string;
  time?: TimePresentation | undefined;
  unknown?: 'somevalue' | 'novalue' | 'coordinates-unsupported' | 'value' | undefined;
};
export type MusicContextStream = Pick<RelationField, 'id' | 'label'>;
export type MusicContextLink = {
  id: string;
  label: string;
  targetKind?: Exclude<MusicContextKind, 'unsupported'> | undefined;
  property: string;
  position: number;
  occurrence?: string | undefined;
  date?: { property: string; label: string; time: TimePresentation } | undefined;
  role?:
    | {
        property: string;
        label: string;
        text?: string | undefined;
        target?:
          | { id: string; label: string; targetKind?: Exclude<MusicContextKind, 'unsupported'> | undefined }
          | undefined;
        unknown?: 'somevalue' | 'novalue' | 'value' | undefined;
      }
    | undefined;
  unreadable?: boolean | undefined;
};
export type MusicContextFailure = CandidateFailure | { ok: false; reason: 'preparing' };
export type MusicContextRead =
  | MusicContextFailure
  | {
      ok: true;
      public: SubjectRead;
      kind: MusicContextKind;
      facts: MusicContextFact[];
      streams: MusicContextStream[];
      links: MusicContextLink[];
      next: string | null;
      stream?: string | undefined;
      streamUnavailable?: boolean | undefined;
      relationsUnavailable?: boolean | undefined;
      session?: string | undefined;
    };

type Definitions = Pick<Release, 'types' | 'properties'>;

function headersOf(authorization?: string, session?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function tokenOf(result: { headers?: HeadersInit | undefined }) {
  const value = new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
  return value && value.length <= 16384 ? value : undefined;
}

function readFailure(status: number): MusicContextFailure {
  return status === 202 ? { ok: false, reason: 'preparing' } : candidateFailure(status);
}

export function musicContextKind(release: Definitions, type: string): MusicContextKind {
  // Preserve an exact native Type's identity before classifying its admitted ancestors.
  for (const [kind, ids] of Object.entries(musicContextRequested) as [
    Exclude<MusicContextKind, 'unsupported'>,
    readonly string[],
  ][]) {
    if (ids.includes(type) && !!release.types[type]) return kind;
  }
  // AdministrativeArea is also a Place in some releases; show its more specific identity.
  const priority: Exclude<MusicContextKind, 'unsupported'>[] = ['area', 'event', 'instrument', 'place'];
  for (const kind of priority) {
    const ids = musicContextRequested[kind];
    if (ids.some((id) => !!release.types[id] && typeExtends(release, type, id))) return kind;
  }
  return 'unsupported';
}

export async function readMusicContext(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: {
    context?: string | undefined;
    stream?: string | undefined;
    cursor?: string | undefined;
    session?: string | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<MusicContextRead> {
  if (
    (input.context !== undefined && !isExploreId(input.context)) ||
    (input.stream !== undefined && !isMusicContextStream(input.stream)) ||
    (input.cursor !== undefined && (!isMusicContextCursor(input.cursor) || !input.stream))
  )
    return { ok: false, reason: 'invalid' };
  const context = input.context ?? candidateContext;
  const signal = input.signal;
  const fetchOptions = { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) } as const;
  signal?.throwIfAborted();
  const scope = await client.contexts({ id: context }).get({
    headers: headersOf(authorization, input.session),
    fetch: fetchOptions,
  });
  signal?.throwIfAborted();
  if (scope.status !== 200 || !scope.data) return readFailure(scope.status);
  if (scope.data.context.id !== context) return readFailure(409);
  const headers = headersOf(authorization, tokenOf(scope) ?? input.session);
  const current = await client.subjects({ id }).get({
    query: { context, language: locale },
    headers,
    fetch: fetchOptions,
  });
  signal?.throwIfAborted();
  if (current.status !== 200 || !current.data) return readFailure(current.status);
  if (current.data.subject.id !== id || current.data.subject.context !== context) return readFailure(409);
  const kind = musicContextKind(release, current.data.subject.type);
  if (kind === 'unsupported') {
    return { ok: true, public: current.data, kind, facts: [], streams: [], links: [], next: null };
  }
  const facts: MusicContextFact[] = [];
  for (const [property, statements] of Object.entries(current.data.subject.statements)) {
    const definition = release.properties[property];
    if (!definition || definition.relation) continue;
    const label = pickText(definition.labels, locale).text;
    const coordinates =
      definition.datatype === 'string' &&
      /coord|globe|latitude|longitude/i.test(`${property} ${definition.iri} ${label}`);
    for (const statement of statements) {
      if (definition.datatype === 'time') {
        const time = timePresentation(statement.value, locale);
        facts.push({
          property,
          label,
          text: time.text,
          time,
        });
        continue;
      }
      if (statement.value.type === 'somevalue' || statement.value.type === 'novalue') {
        facts.push({ property, label, text: '', unknown: statement.value.type });
        continue;
      }
      if (coordinates) {
        facts.push({ property, label, text: '', unknown: 'coordinates-unsupported' });
        continue;
      }
      if (statement.value.type !== 'value') {
        facts.push({ property, label, text: '', unknown: 'value' });
        continue;
      }
      facts.push({
        property,
        label,
        text:
          typeof statement.value.content === 'string'
            ? statement.value.content
            : (JSON.stringify(statement.value.content) ?? ''),
      });
    }
  }
  const fields = relationFields(release as Release, current.data.subject.type, locale);
  const streams = fields.map(({ id, label }) => ({ id, label }));
  const stream = input.stream === undefined ? fields[0] : fields.find((field) => field.id === input.stream);
  const streamUnavailable = input.stream !== undefined && !stream;
  let links: MusicContextLink[] = [];
  let next: string | null = null;
  let relationsUnavailable = false;
  let session = tokenOf(current) ?? tokenOf(scope) ?? input.session;
  if (stream) {
    const page = await (async () => {
      try {
        return await client.subjects({ id }).relations.get({
          query: {
            property: stream.id,
            language: locale,
            limit: MUSIC_CONTEXT_PAGE_CAP,
            context,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          headers: headersOf(authorization, session),
          fetch: fetchOptions,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof TypeError)) throw error;
        relationsUnavailable = true;
        return undefined;
      }
    })();
    signal?.throwIfAborted();
    if (page) {
      session = tokenOf(page) ?? session;
      const validPage =
        page.status === 200 &&
        !!page.data &&
        'relations' in page.data &&
        Array.isArray(page.data.relations) &&
        (page.data.next === null || isMusicContextCursor(page.data.next));
      if (!validPage) relationsUnavailable = true;
      if (validPage) {
        next = page.data.next;
        const dateField = stream.qualifiers.find((qualifier) => qualifier.datatype === 'time');
        const roleField = stream.slotKey
          ? stream.qualifiers.find((qualifier) => qualifier.id === stream.slotKey)
          : undefined;
        links = page.data.relations
          .filter((row) => row.statement.property.id === stream.id)
          .slice(0, MUSIC_CONTEXT_PAGE_CAP)
          .map((row, index) => {
            const summary = row.summary;
            if (!summary?.id) {
              return {
                id: '',
                label: '',
                property: stream.id,
                position: index + 1,
                ...(typeof row.statement.id === 'string' ? { occurrence: row.statement.id } : {}),
                unreadable: true,
              };
            }
            const date = dateField && row.statement.qualifiers.find((part) => part.property.id === dateField.id);
            const role = roleField && row.statement.qualifiers.find((part) => part.property.id === roleField.id);
            const roleTarget =
              role?.value.type === 'value' && typeof role.value.content === 'string'
                ? row.related?.[role.value.content]
                : undefined;
            const roleVisible =
              !!role && (role.value.type !== 'value' || roleField?.datatype !== 'wikibase-item' || !!roleTarget);
            const targetKind = summary.type ? musicContextKind(release, summary.type) : 'unsupported';
            return {
              id: summary.id,
              label: summary.label?.value ?? '',
              ...(targetKind === 'unsupported' ? {} : { targetKind }),
              property: stream.id,
              position: index + 1,
              ...(typeof row.statement.id === 'string' ? { occurrence: row.statement.id } : {}),
              ...(date && dateField
                ? {
                    date: {
                      property: dateField.id,
                      label: dateField.label,
                      time: timePresentation(date.value, locale),
                    },
                  }
                : {}),
              ...(roleVisible && role && roleField
                ? {
                    role: {
                      property: roleField.id,
                      label: roleField.label,
                      ...(roleTarget
                        ? {
                            target: {
                              id: roleTarget.id,
                              label: roleTarget.label?.value ?? '',
                              ...(musicContextKind(release, roleTarget.type) !== 'unsupported'
                                ? { targetKind: musicContextKind(release, roleTarget.type) }
                                : {}),
                            },
                          }
                        : {}),
                      ...(role.value.type === 'value' && roleField.datatype !== 'wikibase-item'
                        ? {
                            text:
                              typeof role.value.content === 'string'
                                ? role.value.content
                                : (JSON.stringify(role.value.content) ?? ''),
                          }
                        : { unknown: role.value.type }),
                    },
                  }
                : {}),
              unreadable: false,
            };
          });
      }
    }
  }
  return {
    ok: true,
    public: current.data,
    kind,
    facts,
    streams,
    links,
    next,
    ...(stream ? { stream: stream.id } : {}),
    ...(streamUnavailable ? { streamUnavailable: true } : {}),
    ...(relationsUnavailable ? { relationsUnavailable: true } : {}),
    ...(session ? { session } : {}),
  };
}
