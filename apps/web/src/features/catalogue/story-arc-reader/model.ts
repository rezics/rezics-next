import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { partLabels, type PartRow, type PartStream } from '../work-parts';
import { storyArcType, storyArcProperty, storyArcUuid } from '../story-arc-profile';

type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type NativePage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
export type ArcAddress = { id: string; context: string; stream?: string; cursor?: string; arc?: string };
export type ArcStream = PartStream & { kind: 'membership' | 'sequence' | 'appearance'; filter?: string };
export type ArcRead =
  | { ok: false; reason: 'unavailable' | 'withheld' | 'invalid' }
  | {
      ok: true;
      subject: { id: string; type: string; label: ReturnType<typeof pickText> };
      streams: ArcStream[];
      stream?: ArcStream;
      rows: PartRow[];
      labels: ReturnType<typeof partLabels>;
      next: string | null;
      count?: NativePage['count'];
      caughtUp: boolean;
    };
export type ArcTransport = (address: ArcAddress) => Promise<ArcRead>;
export const arcLimit = 20;
const cursorLimit = 4096;
const rowBytes = 128 * 1024;
const pageBytes = arcLimit * rowBytes + 64 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function validArcAddress(input: ArcAddress): boolean {
  return (
    !!input &&
    storyArcUuid.test(input.id) &&
    storyArcUuid.test(input.context) &&
    (input.arc === undefined || storyArcUuid.test(input.arc)) &&
    (input.stream === undefined ||
      (typeof input.stream === 'string' && input.stream.length > 0 && input.stream.length <= 256)) &&
    (input.cursor === undefined ||
      (typeof input.cursor === 'string' &&
        input.cursor.length > 0 &&
        input.cursor.length <= cursorLimit &&
        !!input.stream))
  );
}

/** Distinct released streams; an appearance filter is never a containment or sequence assertion. */
export function arcStreams(release: Definitions, type: string, locale: string, arc?: string): ArcStream[] {
  const definition = release.types[type];
  if (!definition || !release.types[storyArcType]) return [];
  const types = new Set([type, ...definition.bases]);
  return Object.entries(release.properties)
    .flatMap(([property, field]): ArcStream[] => {
      const relation = field.relation;
      if (!relation || field.datatype !== 'wikibase-item') return [];
      // CreativeWork's inherited arc slot is a work's membership list; an arc is only ever a member.
      const forward =
        definition.properties.includes(property) && !(type === storyArcType && property === storyArcProperty);
      if (arc) {
        if (
          property !== 'schema:character' ||
          relation.group !== 'appearance' ||
          !forward ||
          !relation.filter?.includes('wdt:P518')
        )
          return [];
        return [
          {
            key: `forward:${property}`,
            property,
            direction: 'forward',
            label: pickText(field.labels, locale),
            positionEditable: false,
            kind: 'appearance',
            filter: arc,
          },
        ];
      }
      // A work offers only its explicitly released forward arc memberships.
      if (
        type !== storyArcType &&
        (property !== storyArcProperty || !forward || !field.targets?.includes(storyArcType))
      )
        return [];
      if (relation.group !== 'membership' && relation.group !== 'order') return [];
      // This property is a qualifier naming an arc, not a member-work stream.
      if (property === 'wdt:P518') return [];
      const inverse =
        type === storyArcType &&
        field.targets?.some((target) => types.has(target)) &&
        (relation.symmetric || (relation.inverse && relation.inverse !== 'none'));
      const stream = (direction: 'forward' | 'inverse'): ArcStream => ({
        key: `${direction}:${property}`,
        property,
        direction,
        label: pickText(
          direction === 'inverse' && !relation.symmetric ? (relation.inverseLabels ?? field.labels) : field.labels,
          locale,
        ),
        positionEditable: false,
        kind: relation.group === 'order' ? 'sequence' : 'membership',
        ...(relation.slotKey ? { slotKey: relation.slotKey } : {}),
      });
      return [...(forward ? [stream('forward')] : []), ...(inverse ? [stream('inverse')] : [])];
    })
    .sort((a, b) => Number(b.property === storyArcProperty) - Number(a.property === storyArcProperty));
}

const failure = (status: number): ArcRead => ({
  ok: false,
  reason: [401, 403, 404, 308].includes(status) ? 'withheld' : 'unavailable',
});

/** One selected native page, no target hydration, refill, inferred order or recursive expansion. */
export async function readArc(
  client: KernelClient,
  definitions: Definitions | Promise<Definitions>,
  address: ArcAddress,
  locale: string,
): Promise<ArcRead> {
  if (!validArcAddress(address)) return { ok: false, reason: 'invalid' };
  try {
    const options = { fetch: { cache: 'no-store' as const, redirect: 'manual' as const } };
    const [current, release] = await Promise.all([
      client.subjects({ id: address.id }).get({ query: { context: address.context, language: locale }, ...options }),
      definitions,
    ]);
    if (current.status !== 200 || !current.data) return failure(current.status);
    const source = current.data.subject;
    if (source.id !== address.id || source.context !== address.context) return { ok: false, reason: 'withheld' };
    if (bytes(current.data) > 4 * 1024 * 1024) return { ok: false, reason: 'unavailable' };
    const streams = arcStreams(release, source.type, locale, address.arc);
    if (streams.length > 64) return { ok: false, reason: 'unavailable' };
    const stream = address.stream ? streams.find((item) => item.key === address.stream) : streams[0];
    if (address.stream && !stream) return { ok: false, reason: 'invalid' };
    const subject = { id: address.id, type: source.type, label: pickText(source.labels, locale) };
    if (!stream) return { ok: true, subject, streams, rows: [], labels: {}, next: null, caughtUp: true };
    const query = {
      property: stream.property,
      context: address.context,
      language: locale,
      limit: arcLimit,
      ...(stream.filter ? { filter: stream.filter } : {}),
      ...(address.cursor ? { cursor: address.cursor } : {}),
    };
    const result =
      stream.direction === 'forward'
        ? await client.subjects({ id: address.id }).relations.get({ query, ...options })
        : await client.subjects({ id: address.id }).links.get({ query, ...options });
    if (result.status !== 200 || !result.data) return failure(result.status);
    const page = result.data;
    if ('links' in page && page.links.some((row) => row.property !== stream.property))
      return { ok: false, reason: 'unavailable' };
    if (
      'relations' in page &&
      page.relations.some(
        (row) => row.target !== (row.statement.value.type === 'value' ? row.statement.value.content : null),
      )
    )
      return { ok: false, reason: 'unavailable' };
    const nativeRows = 'relations' in page ? page.relations : page.links;
    if (
      nativeRows.length > arcLimit ||
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
        Object.entries(values ?? {})
          .filter(([id, summary]) => summary.id === id)
          .map(([id, summary]) => [
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
      const assertion = row.statement;
      if (
        seen.has(key) ||
        !storyArcUuid.test(row.holder) ||
        !storyArcUuid.test(row.statementId) ||
        (assertion && (assertion.id !== row.statementId || assertion.property.id !== stream.property)) ||
        (row.summary &&
          (!storyArcUuid.test(row.summary.id) ||
            (stream.direction === 'inverse'
              ? row.summary.id !== row.holder
              : assertion?.value.type !== 'value' || assertion.value.content !== row.summary.id))) ||
        (stream.direction === 'inverse' &&
          assertion &&
          (assertion.value.type !== 'value' || assertion.value.content !== address.id)) ||
        (stream.filter &&
          (!assertion ||
            !assertion.qualifiers.some(
              (snak) =>
                snak.property.id === 'wdt:P518' && snak.value.type === 'value' && snak.value.content === stream.filter,
            )))
      )
        return { ok: false, reason: 'unavailable' };
      seen.add(key);
    }
    return {
      ok: true,
      subject,
      streams,
      stream,
      rows,
      labels: partLabels(release, rows, locale),
      next: page.next,
      ...(page.count ? { count: page.count } : {}),
      caughtUp: page.freshness.caught_up,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
