import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { releaseUuid, admittedProperty, isA, dateReading, selectedStatements } from '../release-fidelity/model';
import type { GuideRelease } from '../definition-guide';
import { partLabels, type PartRow, type PartStream } from '../work-parts';

type Definitions = Pick<Release, 'types' | 'properties'>;
export const musicReleaseType = 'schema:MusicRelease';
export function isMusicRelease(release: Definitions, type: string) {
  return !!release.types[type] && !!release.types[musicReleaseType] && isA(release, type, musicReleaseType);
}
export function musicReleaseEntry(type: string, types?: readonly string[]) {
  return type === musicReleaseType || !!types?.includes(musicReleaseType);
}
type Endpoint = ReturnType<KernelClient['subjects']>;
type NativePage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
export type MusicReleaseAddress = { id: string; context: string; stream?: string; cursor?: string };
export type MusicReleaseRead =
  | { ok: false; reason: 'unavailable' | 'withheld' | 'invalid' }
  | {
      ok: true;
      identity: { id: string; label: ReturnType<typeof pickText> };
      public: SubjectRead;
      digest: string;
      admitted: boolean;
      facts: MusicReleaseFact[];
      unsupported: string[];
      streams: PartStream[];
      stream?: PartStream;
      rows: PartRow[];
      labels: ReturnType<typeof partLabels>;
      types: Record<string, ReturnType<typeof pickText>>;
      next: string | null;
      count?: NativePage['count'];
      caughtUp: boolean;
    };
export type MusicReleaseTransport = (address: MusicReleaseAddress) => Promise<MusicReleaseRead>;
export const musicReleaseLimit = 20;
const cursorLimit = 4096;
const rowBytes = 128 * 1024;
const pageBytes = musicReleaseLimit * rowBytes + 64 * 1024;

export function validMusicReleaseAddress(input: MusicReleaseAddress): boolean {
  return (
    !!input &&
    releaseUuid.test(input.id) &&
    releaseUuid.test(input.context) &&
    (input.stream === undefined ||
      (typeof input.stream === 'string' && input.stream.length > 0 && input.stream.length <= 256)) &&
    (input.cursor === undefined ||
      (typeof input.cursor === 'string' &&
        input.cursor.length > 0 &&
        input.cursor.length <= cursorLimit &&
        !!input.stream))
  );
}

/** A listing assertion, not its target, identifies one occurrence in a native window. */
export function musicReleaseOccurrenceKey(row: Pick<PartRow, 'holder' | 'statementId'>): string {
  return `${row.holder}:${row.statementId}`;
}

export const musicReleasePreviousLimit = 8;
export type MusicReleaseWindowIntent = 'start' | 'next' | 'previous';
export type MusicReleasePending = {
  address: MusicReleaseAddress;
  intent: MusicReleaseWindowIntent;
};

/** Addresses only: no prior response, target set, inferred offset or stream frontier cache. */
export type MusicReleaseNavigation = {
  accepted?: MusicReleaseAddress;
  previous: MusicReleaseAddress[];
  pending?: MusicReleasePending;
};

export function musicReleaseFirstAddress(
  address: Pick<MusicReleaseAddress, 'id' | 'context'>,
  stream?: string,
): MusicReleaseAddress {
  return { id: address.id, context: address.context, ...(stream ? { stream } : {}) };
}

export function sameMusicReleaseAddress(left: MusicReleaseAddress, right: MusicReleaseAddress): boolean {
  return (
    left.id === right.id &&
    left.context === right.context &&
    left.stream === right.stream &&
    left.cursor === right.cursor
  );
}

export function musicReleaseNavigation(
  address: MusicReleaseAddress,
  page?: Extract<MusicReleaseRead, { ok: true }>,
): MusicReleaseNavigation {
  return {
    ...(page ? { accepted: musicReleaseFirstAddress(address, page.stream?.key) } : {}),
    previous: [],
  };
}

/** Next always pairs the frontier with the stream of the one accepted response. */
export function musicReleaseNextAddress(
  navigation: MusicReleaseNavigation,
  page: Extract<MusicReleaseRead, { ok: true }>,
): MusicReleaseAddress | undefined {
  const accepted = navigation.accepted;
  if (!accepted || !page.stream || !page.next || accepted.stream !== page.stream.key) return undefined;
  return { ...accepted, cursor: page.next };
}

/** Preserve the exact failed operation, including whether a successful retry consumes Previous. */
export function requestMusicReleaseAddress(
  navigation: MusicReleaseNavigation,
  address: MusicReleaseAddress,
  intent: MusicReleaseWindowIntent,
): MusicReleaseNavigation {
  return {
    ...navigation,
    pending: {
      address: {
        id: address.id,
        context: address.context,
        ...(address.stream ? { stream: address.stream } : {}),
        ...(address.cursor ? { cursor: address.cursor } : {}),
      },
      intent,
    },
  };
}

/** Commit only after a successful native read; unavailable attempts do not consume history. */
export function acceptMusicReleaseAddress(navigation: MusicReleaseNavigation, stream?: string): MusicReleaseNavigation {
  const pending = navigation.pending;
  if (!pending) return navigation;
  const address: MusicReleaseAddress = {
    ...pending.address,
    ...(stream ? { stream } : {}),
  };
  const accepted = navigation.accepted;
  const paired =
    accepted &&
    accepted.id === address.id &&
    accepted.context === address.context &&
    accepted.stream === address.stream;
  let previous: MusicReleaseAddress[] = [];
  if (pending.intent === 'previous' && paired) {
    const last = navigation.previous.at(-1);
    // Previous consumes only the address that was deliberately reread, never an inferred offset.
    previous = last && sameMusicReleaseAddress(last, address) ? navigation.previous.slice(0, -1) : [];
  } else if (pending.intent === 'next' && paired) {
    previous = sameMusicReleaseAddress(accepted, address)
      ? navigation.previous
      : [...navigation.previous, accepted].slice(-musicReleasePreviousLimit);
  }
  return { accepted: address, previous };
}

/** A response cannot attach a different occurrence window to the pending native address. */
export function musicReleaseMatchesAddress(
  page: Extract<MusicReleaseRead, { ok: true }>,
  address: MusicReleaseAddress,
): boolean {
  return (
    page.identity.id === address.id &&
    page.public.subject.id === address.id &&
    page.public.subject.context === address.context &&
    (!address.stream || page.stream?.key === address.stream)
  );
}

/** Exact admitted music identities, never a generic release label or provider code. */
export function musicReleaseStreams(release: Definitions, type: string, locale: string): PartStream[] {
  if (!isMusicRelease(release, type)) return [];
  const kinds = ['schema:MusicRelease', 'rezics:MusicMedium', 'schema:MusicRecording'];
  const belongs = new Set(['schema:isPartOf', 'wdt:P361', 'wdt:P1433']);
  const contains = new Set(['bf:hasPart', 'schema:hasPart']);
  const streams: PartStream[] = [];
  for (const [id, property] of Object.entries(release.properties)) {
    if (!property.relation || property.datatype !== 'wikibase-item') continue;
    const targets = property.targets ?? [];
    const musicTarget = targets.some(
      (target) => !!release.types[target] && kinds.some((kind) => isA(release, target, kind)),
    );
    const forward = admittedProperty(release, type, id) && musicTarget;
    const inverse =
      property.relation.inverse &&
      property.relation.inverse !== 'none' &&
      targets.some((target) => isA(release, type, target)) &&
      Object.entries(release.types).some(
        ([source, descriptor]) =>
          kinds.some((kind) => isA(release, source, kind)) && descriptor.properties.includes(id),
      );
    // Containment has its canonical direction; other explicit music-to-music relations may expose both.
    for (const direction of ['forward', 'inverse'] as const) {
      if (direction === 'forward' ? !forward || belongs.has(id) : !inverse || contains.has(id)) continue;
      streams.push({
        key: `${direction}:${id}`,
        property: id,
        direction,
        label: pickText(direction === 'forward' ? property.labels : (property.relation.inverseLabels ?? {}), locale),
        positionEditable: false,
        ...(property.relation.slotKey ? { slotKey: property.relation.slotKey } : {}),
      });
    }
  }
  return streams;
}

type Statement = SubjectRead['subject']['statements'][string][number];
export type MusicReleaseFact = {
  property: string;
  label: ReturnType<typeof pickText>;
  kind: 'album' | 'date' | 'fact';
  statements: Statement[];
};
const albumProperties = ['schema:releaseOf', 'schema:exampleOfWork'];
const expected = [
  ['schema:datePublished', 'schema:releaseDate'],
  ['schema:musicReleaseFormat', 'wdt:P437'],
  ['schema:contentLocation', 'schema:spatialCoverage', 'wdt:P495', 'wdt:P17'],
];
function factsFor(read: SubjectRead, release: Definitions, locale: string): MusicReleaseFact[] {
  return (release.types[read.subject.type]?.properties ?? []).flatMap((property) => {
    const descriptor = release.properties[property];
    if (!descriptor || ['schema:name', 'schema:description', 'schema:alternateName'].includes(property)) return [];
    const album =
      albumProperties.includes(property) &&
      descriptor.targets?.some((target) => !!release.types[target] && isA(release, target, 'schema:MusicAlbum'));
    return [
      {
        property,
        label: pickText(descriptor.labels, locale),
        kind: album ? ('album' as const) : descriptor.datatype === 'time' ? ('date' as const) : ('fact' as const),
        statements: selectedStatements(read.subject.statements[property]),
      },
    ];
  });
}

/** Only an explicit somevalue means TBA. Unsupported or malformed precision stays unknown. */
export function musicReleaseDate(statement: Statement, digest: string, locale: string) {
  const value = statement.value;
  if (value.type === 'value') {
    const time = value.content as { time?: unknown; precision?: unknown } | null;
    if (
      !time ||
      typeof time.time !== 'string' ||
      typeof time.precision !== 'number' ||
      ![9, 10, 11].includes(time.precision)
    )
      return { kind: 'unknown' as const };
    const parts = /^\+?(-?\d{4,})-(\d{2})-(\d{2})T/.exec(time.time);
    if (!parts) return { kind: 'unknown' as const };
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      (time.precision >= 10 && (month < 1 || month > 12)) ||
      (time.precision === 11 && (day < 1 || day > (days[month - 1] ?? 0)))
    )
      return { kind: 'unknown' as const };
  }
  const reading = dateReading([statement], statement.property.id, digest, locale);
  return value.type === 'value' && reading.kind === 'tba' ? { kind: 'unknown' as const } : reading;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const failure = (status: number): MusicReleaseRead => ({
  ok: false,
  reason: status === 403 || status === 404 || status === 308 ? 'withheld' : 'unavailable',
});

/** One native window, with no refill, target read, sorting or inference from source names. */
export async function readMusicRelease(
  client: KernelClient,
  definitions: GuideRelease | Promise<GuideRelease>,
  address: MusicReleaseAddress,
  locale: string,
): Promise<MusicReleaseRead> {
  if (!validMusicReleaseAddress(address)) return { ok: false, reason: 'invalid' };
  try {
    const [current, release] = await Promise.all([
      client.subjects({ id: address.id }).get({ query: { context: address.context, language: locale } }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return failure(current.status);
    if (current.data.subject.id !== address.id || current.data.subject.context !== address.context)
      return { ok: false, reason: 'withheld' };
    if (bytes(current.data) > 2 * 1024 * 1024) return { ok: false, reason: 'unavailable' };
    const admitted = isMusicRelease(release, current.data.subject.type);
    const facts = admitted ? factsFor(current.data, release, locale) : [];
    const unsupported = admitted
      ? expected
          .filter(
            (properties) =>
              !properties.some((property) => admittedProperty(release, current.data.subject.type, property)),
          )
          .map((properties) => properties[0]!)
      : [];
    const streams = musicReleaseStreams(release, current.data.subject.type, locale);
    if (streams.length > 64) return { ok: false, reason: 'unavailable' };
    const preferred = streams.find((item) => item.key === 'forward:schema:track');
    const stream = address.stream ? streams.find((item) => item.key === address.stream) : (preferred ?? streams[0]);
    if (address.stream && !stream) return { ok: false, reason: 'invalid' };
    const identity = { id: address.id, label: pickText(current.data.subject.labels, locale) };
    const labels = partLabels(
      release,
      facts.flatMap((fact) =>
        fact.statements.map((statement) => ({
          holder: address.id,
          statementId: statement.id,
          statement,
          summary: null,
          related: current.data.related,
        })),
      ),
      locale,
    );
    const common = { identity, public: current.data, digest: release.digest, admitted, facts, unsupported };
    if (!stream) return { ok: true, ...common, streams, rows: [], labels, types: {}, next: null, caughtUp: true };
    const query = {
      property: stream.property,
      context: address.context,
      language: locale,
      limit: musicReleaseLimit,
      ...(address.cursor ? { cursor: address.cursor } : {}),
    };
    const result =
      stream.direction === 'forward'
        ? await client.subjects({ id: address.id }).relations.get({ query })
        : await client.subjects({ id: address.id }).links.get({ query });
    if (result.status !== 200 || !result.data) return failure(result.status);
    const page = result.data;
    if ('links' in page && page.links.some((row) => row.property !== stream.property))
      return { ok: false, reason: 'unavailable' };
    const nativeRows = 'relations' in page ? page.relations : page.links;
    if (
      nativeRows.length > musicReleaseLimit ||
      bytes(page) > pageBytes ||
      nativeRows.some((row) => bytes(row) > rowBytes) ||
      (page.next !== null &&
        (typeof page.next !== 'string' ||
          !page.next.length ||
          page.next.length > cursorLimit ||
          page.next === address.cursor))
    )
      return { ok: false, reason: 'unavailable' };
    const related = (values: NativePage['relations'][number]['related']): SubjectRead['related'] =>
      Object.fromEntries(
        Object.entries(values ?? {}).map(([id, summary]) => [
          id,
          {
            type: summary.type,
            labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
          },
        ]),
      );
    const rows: PartRow[] =
      'relations' in page
        ? page.relations.map((row) => ({
            holder: address.id,
            statementId: row.statement.id,
            statement: row.statement,
            summary: row.summary,
            related: related(row.related),
          }))
        : page.links.map((row) => ({
            holder: row.subject,
            statementId: row.statement,
            ...(row.assertion ? { statement: row.assertion } : {}),
            summary: row.summary,
            related: related(row.related),
          }));
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.holder}:${row.statementId}`;
      if (
        seen.has(key) ||
        !releaseUuid.test(row.holder) ||
        !releaseUuid.test(row.statementId) ||
        (row.statement && (row.statement.id !== row.statementId || row.statement.property.id !== stream.property)) ||
        (row.summary &&
          (!releaseUuid.test(row.summary.id) ||
            (stream.direction === 'inverse'
              ? row.summary.id !== row.holder
              : row.statement?.value.type !== 'value' || row.statement.value.content !== row.summary.id))) ||
        (stream.direction === 'inverse' &&
          row.statement &&
          (row.statement.value.type !== 'value' || row.statement.value.content !== address.id))
      )
        return { ok: false, reason: 'unavailable' };
      seen.add(key);
    }
    const types = Object.fromEntries(
      rows.flatMap((row) =>
        row.summary
          ? [
              [
                row.summary.type,
                {
                  ...pickText(release.types[row.summary.type]?.labels ?? {}, locale),
                  text: pickText(release.types[row.summary.type]?.labels ?? {}, locale).text || row.summary.type,
                },
              ],
            ]
          : [],
      ),
    );
    return {
      ok: true,
      ...common,
      streams,
      stream,
      rows,
      labels: { ...labels, ...partLabels(release, rows, locale) },
      types,
      next: page.next,
      ...(page.count ? { count: page.count } : {}),
      caughtUp: page.freshness.caught_up,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
