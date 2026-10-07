import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { feedSources, feedReviewSources } from './source.ts';
import { feedWorkAuthors, followIdentities } from './presentation.ts';
import { AUTHOR_NEWS_KINDS } from './presentation.ts';
import type { FeedCheckpoint } from './store.ts';
import { refreshReadRankingAdmissions } from './ranking-admission.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';

const BATCH = 20;
interface Reference { id: string; kind: string; group_key: string; work: string | null }
/** Shared target indexes, no reader fan-out. Every rebuild/author correction
 * seeks the saved reference key and commits its new checkpoint with the keys. */
export class FeedTargetIndex {
  constructor(private readonly access: Pool, private readonly relay: Pool) {}

  async tick(session: WorkReadSession, checkpoint: FeedCheckpoint, through: string) {
    const epoch = checkpoint.data_epoch;
    await this.access.query(`INSERT INTO access.feed_target_checkpoint(data_epoch,sequence,after_event)
      VALUES($1,$2,'￿') ON CONFLICT DO NOTHING`, [epoch, checkpoint.sequence]);
    const pending = (await this.access.query<Reference>(`SELECT id,kind,group_key,work FROM access.feed_item
      WHERE data_epoch=$1 AND NOT target_indexed ORDER BY id LIMIT $2`, [epoch,BATCH])).rows;
    if (pending.length) { await this.project(session, epoch, pending); return true; }
    const dirty = (await this.access.query<{ work: string; after_id: string }>(
      'SELECT work,after_id FROM access.feed_author_dirty WHERE data_epoch=$1 ORDER BY work LIMIT 1', [epoch])).rows[0];
    if (dirty) {
      const rows = (await this.access.query<Reference>(`SELECT id,kind,group_key,work FROM access.feed_item
        WHERE data_epoch=$1 AND work=$2 AND id>$3 ORDER BY id LIMIT $4`, [epoch,dirty.work,dirty.after_id,BATCH])).rows;
      await this.project(session, epoch, rows, true);
      await this.access.query(rows.length === BATCH
        ? 'UPDATE access.feed_author_dirty SET after_id=$3 WHERE data_epoch=$1 AND work=$2'
        : 'DELETE FROM access.feed_author_dirty WHERE data_epoch=$1 AND work=$2',
      rows.length === BATCH ? [epoch,dirty.work,rows.at(-1)!.id] : [epoch,dirty.work]);
      return true;
    }
    const position = (await this.access.query<{ sequence: string; after_event: string }>(
      'SELECT sequence::text,after_event FROM access.feed_target_checkpoint WHERE data_epoch=$1', [epoch])).rows[0]!;
    if (position.sequence === through && position.after_event === '￿') return false;
    const events = (await this.relay.query<{ sequence: string; event_id: string; work: string | null; type: string }>(`
      SELECT sequence::text,event_id,envelope->>'type' AS type,
        COALESCE(envelope#>>'{data,receipt,work}',envelope#>>'{data,receipt,metadata,work}',
          envelope#>>'{data,payload,work}',envelope#>>'{data,work}') AS work
      FROM relay.delivered_event WHERE stream_scope='${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch=$1 AND sequence<=$2
        AND (sequence>$3::numeric OR sequence=$3::numeric AND $4<>'￿' AND event_id>$4)
        ORDER BY sequence,event_id LIMIT $5`,
    [epoch,through,position.sequence,position.after_event,BATCH])).rows;
    // An exactly full final batch leaves an event key at `through`. Its next
    // empty seek must seal that sequence, or readiness remains partial forever.
    await controlTransaction(this.access, async client => {
      // Any Work mutation may replace reported or native credits. Only that
      // Work's indexed history is dirtied; unrelated Works are untouched.
      const works = [...new Set(events.flatMap(event => event.work ? [event.work] : []))];
      if (works.length) await client.query(`INSERT INTO access.feed_author_dirty(data_epoch,work)
        SELECT $1,w FROM unnest($2::text[]) w WHERE EXISTS(SELECT 1 FROM access.feed_item
          WHERE data_epoch=$1 AND work=w) ON CONFLICT(data_epoch,work) DO UPDATE SET after_id=''`, [epoch,works]);
      const last = events.at(-1);
      // Moving the position changes no indexed target. Only `project` writes
      // keys, and it replaces the revision that Following New cursors pin.
      await client.query(`UPDATE access.feed_target_checkpoint SET sequence=$2,after_event=$3 WHERE data_epoch=$1`,
        [epoch,events.length === BATCH ? last!.sequence : through,events.length === BATCH ? last!.event_id : '￿']);
    });
    return true;
  }

  private async project(session: WorkReadSession, epoch: string, refs: Reference[], authorsOnly = false) {
    const graphIds = refs.filter(row => row.kind !== 'review').map(row => row.id);
    const sources = [...await feedSources(session,{ ids: graphIds }),
      ...await feedReviewSources(session, refs.filter(row => row.kind === 'review').map(row => row.id))];
    // Retain opaque keys even when a reference is currently undisclosed. No
    // words, profile or authorization result enter the index.
    const opaque = graphIds.length ? await session.query(`SELECT ?id ?work ?actor ?realm WHERE {
      { VALUES ?id { ${graphIds.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:PublicationSelection ; rv:work ?work ; rv:contribution ?contribution ; rv:context ?context . }
        GRAPH ${iri(GRAPHS.current)} { ?contribution rv:author ?actor . }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context a rv:Realm . BIND(?context AS ?realm) } } }
      UNION { VALUES ?id { ${graphIds.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ; rv:rootTarget ?work ; rv:author ?actor ; rv:realm ?realm . } }
      UNION { VALUES ?id { ${graphIds.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:CollectionRevision ; rv:component ?collection . }
        GRAPH ${iri(GRAPHS.current)} { ?collection rv:curator ?actor . } }
    } LIMIT ${refs.length + 1}`,refs.length + 1) : [];
    const byId = new Map(sources.map(source => [source.id,source]));
    const fallback = new Map(opaque.map(row => [row.id!.value,row]));
    const works = [...new Set(refs.flatMap(row => {
      const work = byId.get(row.id)?.work ?? fallback.get(row.id)?.work?.value ?? row.work;
      return work ? [work] : [];
    }))];
    const authors = await feedWorkAuthors(session, works);
    await refreshReadRankingAdmissions(session.deps.environment,this.access,works);
    await controlTransaction(this.access, async client => {
      for (const ref of refs) {
        const source = byId.get(ref.id), raw = fallback.get(ref.id);
        const work = source?.work ?? raw?.work?.value ?? ref.work;
        const actor = source?.actor ?? raw?.actor?.value;
        const realm = source?.realm ?? raw?.realm?.value;
        const direct = source ? followIdentities(source) : [...new Set([work,actor,realm].filter((id): id is string => !!id))];
        const credited = work && AUTHOR_NEWS_KINDS.includes(ref.kind as typeof AUTHOR_NEWS_KINDS[number])
          ? followIdentities({ kind: ref.kind as typeof AUTHOR_NEWS_KINDS[number],work,actor: '',realm: null,zone: null },authors.get(work))
            .filter(id => id !== work) : [];
        const anchor = (await client.query<{ id: string; sort_time: Date; kind: string }>(`SELECT id,sort_time,kind FROM access.feed_item
          WHERE data_epoch=$1 AND group_key=$2 AND group_leader LIMIT 1`, [epoch,ref.group_key])).rows[0];
        if (!anchor) throw new WorkReadUnavailable('Feed group is unavailable');
        if (authorsOnly) {
          await client.query('UPDATE access.feed_target SET author=false WHERE data_epoch=$1 AND id=$2 AND work=$3', [epoch,anchor.id,work]);
          await client.query('DELETE FROM access.feed_target WHERE data_epoch=$1 AND id=$2 AND NOT direct AND NOT author', [epoch,anchor.id]);
        }
        for (const [keys,author] of [[direct,false],[credited,true]] as const) if (keys.length) {
          await client.query(`INSERT INTO access.feed_target(data_epoch,target,id,sort_time,work,direct,author,kind)
            SELECT $1,target,$3,$4,$5,$6,$7,$8 FROM unnest($2::text[]) target ON CONFLICT(data_epoch,target,id)
            DO UPDATE SET direct=access.feed_target.direct OR EXCLUDED.direct,author=access.feed_target.author OR EXCLUDED.author`,
          [epoch,keys,anchor.id,anchor.sort_time,work,!author,author,anchor.kind]);
        }
        await client.query('UPDATE access.feed_item SET target_indexed=true,work=$3 WHERE data_epoch=$1 AND id=$2', [epoch,ref.id,work]);
      }
      await client.query('UPDATE access.feed_target_checkpoint SET revision=$2 WHERE data_epoch=$1', [epoch,randomUUID()]);
    });
  }
}
