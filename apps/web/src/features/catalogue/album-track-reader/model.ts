import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { albumType, albumUuid } from '../album-profile';
import { partLabels, partStreams, type PartRow, type PartStream } from '../work-parts';

type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type NativePage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
export type AlbumTrackAddress = { id: string; context: string; stream?: string; cursor?: string };
export type AlbumTrackRead =
  | { ok: false; reason: 'unavailable' | 'withheld' | 'invalid' }
  | {
      ok: true;
      album: { id: string; label: ReturnType<typeof pickText> };
      streams: PartStream[];
      stream?: PartStream;
      rows: PartRow[];
      labels: ReturnType<typeof partLabels>;
      types: Record<string, ReturnType<typeof pickText>>;
      next: string | null;
      count?: NativePage['count'];
      caughtUp: boolean;
    };
export type AlbumTrackTransport = (address: AlbumTrackAddress) => Promise<AlbumTrackRead>;
export const albumTrackLimit = 20;
const cursorLimit = 4096;
const rowBytes = 128 * 1024;
const pageBytes = albumTrackLimit * rowBytes + 64 * 1024;

export function validAlbumTrackAddress(input: AlbumTrackAddress): boolean {
  return (
    !!input &&
    albumUuid.test(input.id) &&
    albumUuid.test(input.context) &&
    (input.stream === undefined ||
      (typeof input.stream === 'string' && input.stream.length > 0 && input.stream.length <= 256)) &&
    (input.cursor === undefined ||
      (typeof input.cursor === 'string' &&
        input.cursor.length > 0 &&
        input.cursor.length <= cursorLimit &&
        !!input.stream))
  );
}

/** Only the installed canonical containment vocabulary; a label never makes a property a track relation. */
export function albumTrackStreams(release: Definitions, locale: string): PartStream[] {
  if (!release.types[albumType]) return [];
  return partStreams(release, albumType, locale).filter((stream) => stream.property !== 'rezics:storyArc');
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const failure = (status: number): AlbumTrackRead => ({
  ok: false,
  reason: status === 403 || status === 404 || status === 308 ? 'withheld' : 'unavailable',
});

/** One native window, with no refill, target read, sorting or inference from source names. */
export async function readAlbumTracks(
  client: KernelClient,
  definitions: Definitions | Promise<Definitions>,
  address: AlbumTrackAddress,
  locale: string,
): Promise<AlbumTrackRead> {
  if (!validAlbumTrackAddress(address)) return { ok: false, reason: 'invalid' };
  try {
    const [current, release] = await Promise.all([
      client.subjects({ id: address.id }).get({ query: { context: address.context, language: locale } }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return failure(current.status);
    if (
      current.data.subject.id !== address.id ||
      current.data.subject.type !== albumType ||
      current.data.subject.context !== address.context
    )
      return { ok: false, reason: 'withheld' };
    const streams = albumTrackStreams(release, locale);
    if (streams.length > 64) return { ok: false, reason: 'unavailable' };
    const stream = address.stream ? streams.find((item) => item.key === address.stream) : streams[0];
    if (address.stream && !stream) return { ok: false, reason: 'invalid' };
    const album = { id: address.id, label: pickText(current.data.subject.labels, locale) };
    if (!stream) return { ok: true, album, streams, rows: [], labels: {}, types: {}, next: null, caughtUp: true };
    const query = {
      property: stream.property,
      context: address.context,
      language: locale,
      limit: albumTrackLimit,
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
      nativeRows.length > albumTrackLimit ||
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
        !albumUuid.test(row.holder) ||
        !albumUuid.test(row.statementId) ||
        (row.statement && (row.statement.id !== row.statementId || row.statement.property.id !== stream.property)) ||
        (row.summary &&
          (!albumUuid.test(row.summary.id) ||
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
      album,
      streams,
      stream,
      rows,
      labels: partLabels(release, rows, locale),
      types,
      next: page.next,
      ...(page.count ? { count: page.count } : {}),
      caughtUp: page.freshness.caught_up,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
