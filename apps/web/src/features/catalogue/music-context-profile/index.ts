import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import { MUSIC_CONTEXT_PAGE_CAP, typeExtends } from '../../pages/graph-browser';
import { relationFields } from '../../../subject/relation-candidates';

export const musicContextRequested = {
  place: ['schema:Place', 'schema:MusicVenue'] as const,
  event: ['schema:Event', 'schema:MusicEvent'] as const,
  area: ['schema:AdministrativeArea'] as const,
  instrument: ['schema:MusicInstrument', 'wd:Q34379'] as const,
} as const;

export type MusicContextKind = 'place' | 'event' | 'area' | 'instrument' | 'unsupported';
export type MusicContextFact = {
  property: string;
  label: string;
  text: string;
  precision?: string | undefined;
  unknown?: boolean | undefined;
};
export type MusicContextLink = {
  id: string;
  label: string;
  property: string;
  direction: 'out' | 'in';
  date?: string | undefined;
  role?: string | undefined;
  unreadable?: boolean | undefined;
};
export type MusicContextRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      kind: MusicContextKind;
      facts: MusicContextFact[];
      links: MusicContextLink[];
      next: string | null;
      stream?: string | undefined;
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
  return new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
}

export function musicContextKind(release: Definitions, type: string): MusicContextKind {
  for (const [kind, ids] of Object.entries(musicContextRequested) as [Exclude<MusicContextKind, 'unsupported'>, readonly string[]][]) {
    if (ids.some((id) => !!release.types[id] && typeExtends(release, type, id))) return kind;
  }
  return 'unsupported';
}

function timeText(content: unknown): { text: string; precision?: string; unknown?: boolean } {
  if (!content || typeof content !== 'object') return { text: '', unknown: true };
  const value = content as { time?: unknown; precision?: unknown };
  if (typeof value.time !== 'string' || !value.time) return { text: '', unknown: true };
  const precision = typeof value.precision === 'number' ? String(value.precision) : undefined;
  const iso = value.time.replace(/^\+/, '');
  const text = precision === '9' ? iso.slice(0, 4) : precision === '10' ? iso.slice(0, 7) : iso.slice(0, 10);
  return { text, ...(precision ? { precision } : {}), ...(precision !== '11' ? { unknown: precision === undefined } : {}) };
}

export async function readMusicContext(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: { stream?: string | undefined; cursor?: string | undefined; session?: string | undefined },
): Promise<MusicContextRead> {
  try {
    const headers = headersOf(authorization, input.session);
    const current = await client.subjects({ id }).get({ headers });
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id) return candidateFailure(400);
    const kind = musicContextKind(release, current.data.subject.type);
    if (kind === 'unsupported') {
      return { ok: true, public: current.data, kind, facts: [], links: [], next: null };
    }
    const facts: MusicContextFact[] = [];
    for (const [property, statements] of Object.entries(current.data.subject.statements)) {
      const definition = release.properties[property];
      if (!definition || definition.relation) continue;
      const label = pickText(definition.labels, locale).text;
      for (const statement of statements) {
        if (definition.datatype === 'time') {
          const time = timeText(statement.value.type === 'value' ? statement.value.content : undefined);
          facts.push({
            property,
            label,
            text: time.text,
            ...(time.precision ? { precision: time.precision } : {}),
            unknown: time.unknown || statement.value.type !== 'value',
          });
          continue;
        }
        if (definition.datatype === 'string' && /coord|globe|latitude|longitude/i.test(property)) {
          facts.push({ property, label, text: '', unknown: true });
          continue;
        }
        if (statement.value.type !== 'value') {
          facts.push({ property, label, text: '', unknown: true });
          continue;
        }
        facts.push({
          property,
          label,
          text: typeof statement.value.content === 'string' ? statement.value.content : JSON.stringify(statement.value.content),
        });
      }
    }
    const streams = relationFields(release as Release, current.data.subject.type, locale);
    const stream = streams.find((field) => field.id === input.stream) ?? streams[0];
    let links: MusicContextLink[] = [];
    let next: string | null = null;
    let session = tokenOf(current) ?? input.session;
    if (stream) {
      const page = await client.subjects({ id }).relations.get({
        query: {
          property: stream.id,
          language: locale,
          limit: MUSIC_CONTEXT_PAGE_CAP,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        headers: headersOf(authorization, session),
      });
      if (page.status !== 200 || !page.data || !('relations' in page.data)) return candidateFailure(page.status);
      session = tokenOf(page) ?? session;
      next = page.data.next;
      links = page.data.relations.map((row) => {
        const date = row.statement.qualifiers.find((part) => part.property.data_type === 'time');
        const role = row.statement.qualifiers.find((part) => part.property.id === stream.slotKey);
        return {
          id: row.summary?.id ?? '',
          label: row.summary?.label?.value ?? '',
          property: stream.id,
          direction: 'out' as const,
          ...(date ? { date: timeText(date.value.type === 'value' ? date.value.content : undefined).text } : {}),
          ...(role && role.value.type === 'value' && typeof role.value.content === 'string' ? { role: role.value.content } : {}),
          unreadable: !row.summary,
        };
      });
    }
    return {
      ok: true,
      public: current.data,
      kind,
      facts,
      links,
      next,
      ...(stream ? { stream: stream.id } : {}),
      ...(session ? { session } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
