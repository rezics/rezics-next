import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { releaseUuid } from '../release-fidelity/model';
import { musicContextKind, musicContextRequested, type MusicContextKind } from '../music-context-profile';
import { partLabels, type PartRow, type PartStream } from '../work-parts';

type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type InversePage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;

export const musicLocationPageLimit = 20;
const maximumStreams = 64;
const maximumSubjectBytes = 2 * 1024 * 1024;
const maximumRowBytes = 128 * 1024;
const maximumPageBytes = musicLocationPageLimit * maximumRowBytes + 64 * 1024;
const maximumCursorLength = 4096;

export type MusicLocationSnapshot = {
  id: string;
  context: string;
  type: string;
  revision: number;
  release: string;
};

export type MusicLocationAddress = MusicLocationSnapshot & {
  stream?: string | undefined;
  cursor?: string | undefined;
  session?: string | undefined;
};

export type MusicLocationFailure = {
  ok: false;
  reason: 'denied' | 'withheld' | 'unavailable' | 'invalid' | 'stale';
};

export type MusicLocationRead =
  | MusicLocationFailure
  | {
      ok: true;
      kind: MusicContextKind;
      identity: {
        typeLabel: ReturnType<typeof pickText>;
      };
      streams: PartStream[];
      stream?: PartStream | undefined;
      rows: PartRow[];
      labels: ReturnType<typeof partLabels>;
      types: Record<string, ReturnType<typeof pickText>>;
      next: string | null;
      count?: ForwardPage['count'] | undefined;
      caughtUp: boolean;
      session?: string | undefined;
    };

export type MusicLocationTransport = (address: MusicLocationAddress) => Promise<MusicLocationRead>;

export function musicLocationEntry(type: string, types?: readonly string[] | undefined): boolean {
  return Object.values(musicContextRequested).some((ids) => ids.some((id) => type === id || types?.includes(id)));
}

export function musicLocationSnapshot(
  subject: SubjectRead['subject'],
  context = subject.context,
): MusicLocationSnapshot {
  return {
    id: subject.id,
    context,
    type: subject.type,
    revision: subject.revision,
    release: subject.release,
  };
}

function isType(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

function hasProperty(release: Definitions, type: string, property: string, seen = new Set<string>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  const descriptor = release.types[type];
  return (
    !!descriptor &&
    (descriptor.properties.includes(property) ||
      descriptor.bases.some((base) => hasProperty(release, base, property, seen)))
  );
}

function admittedProperties(release: Definitions, type: string, seen = new Set<string>()): string[] {
  if (seen.has(type)) return [];
  seen.add(type);
  const descriptor = release.types[type];
  if (!descriptor) return [];
  const inherited = descriptor.bases.flatMap((base) => admittedProperties(release, base, seen));
  return [...new Set([...descriptor.properties, ...inherited])];
}

function relationProperty(release: Definitions, id: string) {
  const property = release.properties[id];
  if (
    !property ||
    property.datatype !== 'wikibase-item' ||
    !property.relation ||
    property.relation.group === 'classification' ||
    !property.targets?.length
  )
    return;
  return property;
}

/** The released Type and Property definitions decide which exact relation streams can be read. */
export function musicLocationStreams(release: Definitions, type: string, locale: string): PartStream[] {
  if (musicContextKind(release, type) === 'unsupported') return [];
  const streams: PartStream[] = [];
  for (const id of admittedProperties(release, type)) {
    const property = relationProperty(release, id);
    if (!property) continue;
    const label = pickText(property.labels, locale);
    if (!label.text) continue;
    streams.push({
      key: `out:${id}`,
      property: id,
      direction: 'forward',
      label,
      positionEditable: false,
      ...(property.relation!.slotKey ? { slotKey: property.relation!.slotKey } : {}),
    });
  }

  for (const descriptor of Object.values(release.types)) {
    for (const id of descriptor.properties) {
      const property = relationProperty(release, id);
      const relation = property?.relation;
      if (
        !property ||
        !relation?.inverse ||
        relation.inverse === 'none' ||
        !property.targets?.some((target) => isType(release, type, target))
      )
        continue;
      const label = pickText(relation.inverseLabels ?? {}, locale);
      if (!label.text || streams.some((stream) => stream.key === `in:${id}`)) continue;
      streams.push({
        key: `in:${id}`,
        property: id,
        direction: 'inverse',
        label,
        positionEditable: false,
        ...(relation.slotKey ? { slotKey: relation.slotKey } : {}),
      });
    }
  }
  return streams.sort(
    (left, right) => left.label.text.localeCompare(right.label.text, locale) || left.key.localeCompare(right.key),
  );
}

export function validMusicLocationAddress(address: MusicLocationAddress): boolean {
  return (
    !!address &&
    releaseUuid.test(address.id) &&
    releaseUuid.test(address.context) &&
    typeof address.type === 'string' &&
    address.type.length > 0 &&
    address.type.length <= 256 &&
    Number.isSafeInteger(address.revision) &&
    address.revision > 0 &&
    typeof address.release === 'string' &&
    address.release.length > 0 &&
    address.release.length <= 256 &&
    (address.stream === undefined ||
      (typeof address.stream === 'string' && address.stream.length > 0 && address.stream.length <= 256)) &&
    (address.cursor === undefined ||
      (typeof address.cursor === 'string' &&
        address.cursor.length > 0 &&
        address.cursor.length <= maximumCursorLength &&
        !!address.stream)) &&
    (address.session === undefined ||
      (typeof address.session === 'string' && address.session.length > 0 && address.session.length <= 16_384))
  );
}

function headersOf(authorization?: string, session?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function sessionOf(result: { headers?: HeadersInit | undefined }) {
  return new Headers(result.headers ?? {}).get('rezics-session-token') || undefined;
}

function failure(status: number): MusicLocationFailure {
  return {
    ok: false,
    reason: status === 401 ? 'denied' : status === 403 || status === 404 || status === 308 ? 'withheld' : 'unavailable',
  };
}

function byteSize(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(json).byteLength;
}

function allowedTarget(release: Definitions, actual: string, targets: readonly string[]): boolean {
  return targets.some((target) => actual === target || isType(release, actual, target));
}

function currentTypeAdmits(release: Definitions, type: string, property: string): boolean {
  const definition = relationProperty(release, property);
  return !!definition && hasProperty(release, type, property);
}

function validRow(release: Definitions, stream: PartStream, current: MusicLocationSnapshot, row: PartRow): boolean {
  if (!releaseUuid.test(row.holder) || !releaseUuid.test(row.statementId)) return false;
  const property = relationProperty(release, stream.property);
  if (!property) return false;
  if (stream.direction === 'forward' && !currentTypeAdmits(release, current.type, stream.property)) return false;
  if (row.summary && !releaseUuid.test(row.summary.id)) return false;

  if (stream.direction === 'forward') {
    const statement = row.statement;
    if (!statement || statement.id !== row.statementId || statement.property.id !== stream.property) return false;
    if (statement.value.type !== 'value' || typeof statement.value.content !== 'string') return false;
    if (row.summary && statement.value.content !== row.summary.id) return false;
    if (row.summary && !allowedTarget(release, row.summary.type, property.targets ?? [])) return false;
    return true;
  }

  if (!row.summary || row.summary.id !== row.holder || !hasProperty(release, row.summary.type, stream.property))
    return false;
  if (!property.targets?.some((target) => isType(release, current.type, target))) return false;
  if (!row.statement) return true;
  return (
    row.statement.id === row.statementId &&
    row.statement.property.id === stream.property &&
    row.statement.value.type === 'value' &&
    row.statement.value.content === current.id
  );
}

function relatedSummaries(
  values: ForwardPage['relations'][number]['related'] | InversePage['links'][number]['related'],
): SubjectRead['related'] {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([id, summary]) => [
      id,
      {
        type: summary.type,
        labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
      },
    ]),
  );
}

/** One bounded relation window. The exact current Subject is rechecked; targets are never hydrated. */
export async function readMusicLocation(
  client: KernelClient,
  authorization: string | undefined,
  definitions: Definitions | Promise<Definitions>,
  address: MusicLocationAddress,
  locale: string,
): Promise<MusicLocationRead> {
  if (!validMusicLocationAddress(address)) return { ok: false, reason: 'invalid' };
  try {
    const headers = headersOf(authorization, address.session);
    const [current, release] = await Promise.all([
      client.subjects({ id: address.id }).get({
        query: { context: address.context, language: locale },
        headers,
      }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return failure(current.status);
    if (byteSize(current.data) > maximumSubjectBytes) return { ok: false, reason: 'unavailable' };
    const subject = current.data.subject;
    if (
      subject.id !== address.id ||
      subject.context !== address.context ||
      subject.type !== address.type ||
      subject.revision !== address.revision ||
      subject.release !== address.release
    )
      return { ok: false, reason: 'stale' };

    const kind = musicContextKind(release, subject.type);
    const typeLabel = pickText(release.types[subject.type]?.labels ?? {}, locale);
    const identity = {
      typeLabel: typeLabel.text ? typeLabel : { text: subject.type, lang: null },
    };
    const streams = musicLocationStreams(release, subject.type, locale);
    if (streams.length > maximumStreams) return { ok: false, reason: 'unavailable' };
    if (kind === 'unsupported') {
      return {
        ok: true,
        kind,
        identity,
        streams: [],
        rows: [],
        labels: {},
        types: {},
        next: null,
        caughtUp: true,
        ...(sessionOf(current) ? { session: sessionOf(current) } : {}),
      };
    }

    const stream = address.stream ? streams.find((item) => item.key === address.stream) : streams[0];
    if ((address.stream && !stream) || (address.cursor && !address.stream)) return { ok: false, reason: 'invalid' };
    let rows: PartRow[] = [];
    let next: string | null = null;
    let count: ForwardPage['count'] | undefined;
    let caughtUp = true;
    let session = sessionOf(current) ?? address.session;

    if (stream) {
      const query = {
        property: stream.property,
        context: address.context,
        language: locale,
        limit: musicLocationPageLimit,
        ...(address.cursor ? { cursor: address.cursor } : {}),
      };
      const result =
        stream.direction === 'forward'
          ? await client
              .subjects({ id: address.id })
              .relations.get({ query, headers: headersOf(authorization, session) })
          : await client.subjects({ id: address.id }).links.get({ query, headers: headersOf(authorization, session) });
      if (result.status !== 200 || !result.data) return failure(result.status);
      session = sessionOf(result) ?? session;
      const page = result.data;
      if ((stream.direction === 'forward') !== 'relations' in page) return { ok: false, reason: 'unavailable' };
      const nativeRows = 'relations' in page ? page.relations : page.links;
      if (
        'relations' in page &&
        page.relations.some((row) => row.statement.value.type !== 'value' || row.target !== row.statement.value.content)
      )
        return { ok: false, reason: 'unavailable' };
      if ('links' in page && page.links.some((row) => row.property !== stream.property))
        return { ok: false, reason: 'unavailable' };
      if (
        nativeRows.length > musicLocationPageLimit ||
        byteSize(page) > maximumPageBytes ||
        nativeRows.some((row) => byteSize(row) > maximumRowBytes) ||
        (page.next !== null &&
          (typeof page.next !== 'string' ||
            !page.next.length ||
            page.next.length > maximumCursorLength ||
            page.next === address.cursor))
      )
        return { ok: false, reason: 'unavailable' };

      rows =
        'relations' in page
          ? page.relations.map((row) => ({
              holder: address.id,
              statementId: row.statement.id,
              statement: row.statement,
              summary: row.summary,
              related: relatedSummaries(row.related),
            }))
          : page.links.map((row) => ({
              holder: row.subject,
              statementId: row.statement,
              ...(row.assertion ? { statement: row.assertion } : {}),
              summary: row.summary,
              related: relatedSummaries(row.related),
            }));
      const seen = new Set<string>();
      for (const row of rows) {
        const key = `${row.holder}:${row.statementId}`;
        if (seen.has(key) || !validRow(release, stream, address, row)) return { ok: false, reason: 'unavailable' };
        seen.add(key);
      }
      next = page.next;
      count = !('count' in page) ? undefined : page.count;
      caughtUp = page.freshness.caught_up;
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
      kind,
      identity,
      streams,
      ...(stream ? { stream } : {}),
      rows,
      labels: partLabels(release, rows, locale),
      types,
      next,
      ...(count ? { count } : {}),
      caughtUp,
      ...(session ? { session } : {}),
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
