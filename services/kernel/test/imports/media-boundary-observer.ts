import type { Pool, PoolClient, QueryResult } from 'pg';
import fenceStatement from '../../src/command/fence.sql';
import fenceRead from '../../src/content/read-source-fences.sql';
import type { SourceFenceTuple } from '../../src/content/source-fences.ts';
import type { Envelope, CloudEvent } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { NativeMediaObservation } from './media-boundary.ts';

export type MediaAnchor = { partition: number; epoch: number; position: string; index: number; transactionId: string };
export type MediaTrace = { anchors: Record<string, MediaAnchor[]>; fences: SourceFenceTuple[] };

/** Observe the actual compiled command/fence statements, including rollback. The
 * captured append result supplies the outbox PK; no subject/history scan is used. */
export async function observeMediaPool(pool: Pool) {
  const anchors: MediaTrace['anchors'] = {};
  const fences: SourceFenceTuple[] = [];
  const installed = new WeakSet<PoolClient>();
  const attach = (client: PoolClient) => {
    if (installed.has(client)) return;
    installed.add(client);
    const query = client.query.bind(client);
    let pending: { id: string; anchor: MediaAnchor }[] = [];
    const observed = (text: string | undefined, values: readonly unknown[], result: QueryResult) => {
      if (text === fenceRead.sql) {
        const parameters = Object.fromEntries(fenceRead.params.map((name, index) => [name, values[index]]));
        const tuples = JSON.parse(String(parameters.tuples)) as SourceFenceTuple[];
        for (const tuple of tuples)
          if (!fences.some((f) => JSON.stringify(f) === JSON.stringify(tuple))) fences.push(tuple);
      }
      if (text === fenceStatement.sql && result.rows.length === 1) {
        const parameters = Object.fromEntries(fenceStatement.params.map((name, index) => [name, values[index]]));
        const events = JSON.parse(String(parameters.events)) as { subject?: string; type: string }[];
        events.forEach((event, index) => {
          if (event.subject && event.type.startsWith('com.rezics.content.media.'))
            pending.push({
              id: event.subject,
              anchor: {
                partition: Number(parameters.partition_no),
                epoch: result.rows[0].epoch,
                position: String(result.rows[0].position),
                index,
                transactionId: String(parameters.transaction_id),
              },
            });
        });
      }
      if (text === 'COMMIT') {
        for (const { id, anchor } of pending) (anchors[id] ??= []).push(anchor);
        pending = [];
      } else if (text?.startsWith('ROLLBACK')) pending = [];
    };
    client.query = ((...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : (first as { text?: string })?.text;
      const values = (Array.isArray(args[1]) ? args[1] : (first as { values?: unknown[] })?.values) ?? [];
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = (error: Error | null, result: QueryResult) => {
          if (!error) observed(text, values, result);
          callback(error, result);
        };
        return Reflect.apply(query, client, args);
      }
      return Reflect.apply(query, client, args).then((result: QueryResult) => {
        observed(text, values, result);
        return result;
      });
    }) as PoolClient['query'];
  };
  // Identity setup may already have populated the pool. Observe those clients
  // too, before their next native transaction can append media events.
  pool.on('acquire', attach);
  const client = await pool.connect();
  attach(client);
  client.release();
  return {
    trace: (mediaId?: string): MediaTrace =>
      structuredClone({
        anchors: mediaId === undefined ? anchors : { [mediaId]: anchors[mediaId] ?? [] },
        fences,
      }),
  };
}

export async function readMediaEvents(pool: Pool, mediaId: string, traces: readonly MediaTrace[]) {
  const route = routeOf(mediaId);
  if (route === null) throw new Error('Invalid observed media ID');
  const locators = traces.flatMap((trace) => trace.anchors[mediaId] ?? []);
  const unique = new Map(locators.map((a) => [`${a.epoch}:${a.partition}:${a.position}:${a.index}`, a]));
  const events: { event: CloudEvent; anchor: MediaAnchor }[] = [];
  for (const anchor of [...unique.values()].sort((a, b) => (BigInt(a.position) < BigInt(b.position) ? -1 : 1))) {
    if (anchor.partition !== partitionOf(route)) throw new Error('Cross-partition media observation');
    const result = await pool.query(
      `SELECT id,type,subject,data,recorded_at FROM core.outbox
       WHERE partition_no=$1 AND position=$2 AND event_seq=$3 AND epoch=$4`,
      [anchor.partition, anchor.position, anchor.index, anchor.epoch],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || row.subject !== mediaId) throw new Error('Missing exact native media event');
    events.push({
      anchor,
      event: {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${anchor.partition}.${anchor.epoch}`,
        type: row.type,
        subject: row.subject,
        data: row.data,
        time: row.recorded_at.toISOString(),
        datacontenttype: 'application/json',
        sequence: anchor.position.padStart(19, '0'),
      },
    });
  }
  return events;
}

export async function mediaEnvelope(
  pool: Pool,
  mediaId: string,
  trace: readonly MediaTrace[],
  type: string,
): Promise<Envelope> {
  const found = (await readMediaEvents(pool, mediaId, trace)).find(({ event }) => event.type === type);
  if (!found) throw new Error(`Missing native ${type} event`);
  const { rows } = await pool.query(
    `SELECT event_seq,event_count,id,type,subject,data,recorded_at FROM core.outbox
     WHERE partition_no=$1 AND position=$2 AND epoch=$3 ORDER BY event_seq`,
    [found.anchor.partition, found.anchor.position, found.anchor.epoch],
  );
  if (!rows.length || rows.length > 1000 || rows.length !== rows[0].event_count)
    throw new Error('Invalid bounded native envelope');
  const events: CloudEvent[] = rows.map((row, index) => {
    if (row.event_seq !== index) throw new Error('Missing native event index');
    return {
      ...found.event,
      id: row.id,
      type: row.type,
      subject: row.subject,
      data: row.data,
      time: row.recorded_at.toISOString(),
    };
  });
  return {
    partition: found.anchor.partition,
    epoch: found.anchor.epoch,
    position: BigInt(found.anchor.position),
    events,
  };
}

export async function observeNativeMedia(
  pool: Pool,
  mediaId: string,
  traces: readonly MediaTrace[],
  objects: ReadonlyMap<string, Uint8Array>,
): Promise<NativeMediaObservation> {
  const route = routeOf(mediaId);
  if (route === null) throw new Error('Invalid observed media ID');
  const { rows } = await pool.query(
    `SELECT media_id,container_id,uploader_id,purpose,state,sha256,source_url,credit,provenance,collection_pending,key
     FROM content.media WHERE route=$1 AND media_id=$2`,
    [route, mediaId],
  );
  const row = rows[0];
  if (rows.length !== 1) throw new Error('Missing routed native media row');
  const variants = await pool.query(
    `SELECT format,width,height,media_type,byte_count,sha256,key FROM content.media_variant
     WHERE route=$1 AND media_id=$2 ORDER BY format,width`,
    [route, mediaId],
  );
  const events = await readMediaEvents(pool, mediaId, traces);
  const states: Record<string, NativeMediaObservation['row']['state']> = {
    'com.rezics.content.media.import-requested.v1': 'reserved',
    'com.rezics.content.media.uploaded.v1': 'uploaded',
    'com.rezics.content.media.available.v1': 'available',
    'com.rezics.content.media.rejected.v1': 'rejected',
  };
  const fence = traces
    .flatMap((t) => t.fences)
    .find(
      (tuple) =>
        tuple.source === row.provenance.source &&
        tuple.external_id === row.provenance.external_id &&
        tuple.field_group === row.provenance.field_group,
    );
  if (!fence) throw new Error('No production fence read was observed for this media');
  return {
    row: {
      id: row.media_id,
      containerId: row.container_id,
      uploaderId: row.uploader_id,
      purpose: row.purpose,
      state: row.state,
      sha256: row.sha256,
      sourceUrl: row.source_url,
      credit: row.credit,
      provenance: row.provenance,
      collectionPending: row.collection_pending,
    },
    transitions: events.flatMap(({ event }) => (states[event.type] ? [states[event.type]!] : [])),
    events: events.map(({ event, anchor }) => ({ type: event.type, transactionId: anchor.transactionId })),
    variants: variants.rows.map((v) => {
      const bytes = objects.get(v.key);
      if (!bytes) throw new Error('Native variant object is missing');
      return {
        format: v.format,
        width: v.width,
        height: v.height,
        mediaType: v.media_type,
        byteCount: Number(v.byte_count),
        sha256: v.sha256,
        key: v.key,
        bytes: bytes.slice(),
      };
    }),
    original: objects.get(row.key)?.slice() ?? null,
    fence,
  };
}
