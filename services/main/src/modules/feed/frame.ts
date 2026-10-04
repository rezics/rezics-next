import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import type { FollowKind } from '../follows/contract.ts';
import { DEFAULT_PERSON_CHOICES, type PersonPreferences } from '../preferences/store.ts';
import { PRIMARY_READING_PERSON_SQL } from '../preferences/languages.ts';
import { defaultPreferences, HOME_COST, type HomeExclusion, type HomePreferences } from './personal.ts';
import type { FeedCheckpoint } from './store.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';

interface ActorState { id: string; generation: string; handle: string | null;
  profile_visibility: string; hide_reading_activity: boolean }
interface ReaderRow { checkpoint: FeedCheckpoint | null; revision: string | null;
  preferences: HomePreferences | null; content_languages: string[] | null;
  settings: Record<string, unknown> | null; exclusions: HomeExclusion[];
  blocks: string[]; following_revision: string | null; following_count: number;
  watermark: { data_epoch: string; sequence: string; updated_at: string } | null;
  actors: ActorState[]; pending_reviews: boolean; index_sequence: string | null;
  index_revision: string | null; index_complete: boolean; recovery_generation: string }

const actorRows = `SELECT s.id, s.generation::text, n.key AS handle,
  COALESCE(p.profile_visibility,'public') AS profile_visibility,
  COALESCE(p.hide_reading_activity,false) AS hide_reading_activity
  FROM access.authority_subject s
  LEFT JOIN access.person_preferences p ON p.agent_id = s.id
  LEFT JOIN access.alias_registry n ON n.holder = s.id AND n.scope = 'agent' AND n.state = 'current'
  WHERE s.id = ANY($3::text[]) AND s.kind = 'agent' AND s.active ORDER BY s.id`;

/** One opening and one closing Access cut. The opening cut reads each private
 * inventory once; the closing cut reads revisions and the exact actor keys.
 * Neither cut is retained between requests, and both revalidate live authority
 * and the recovery fence. No graph/Content wait holds an Access transaction. */
export class FeedReadFrame {
  private actors = new Map<string, ActorState>();
  private usedTargetIndex = false;
  private constructor(private readonly pool: Pool, readonly principal: VerifiedPrincipal | null,
    readonly agent: string | null, readonly epoch: string, readonly owner: string | null,
    private readonly opening: ReaderRow) {}

  static async open(pool: Pool, epoch: string, reader?: { principal: VerifiedPrincipal; agent: string }) {
    return controlRead(pool, async client => {
      const owner = reader ? await followPrincipal(client, reader.principal, reader.agent) : null;
      const row = await FeedReadFrame.state(client, owner, reader?.agent ?? null, [], true);
      if (!row.checkpoint || row.checkpoint.data_epoch !== epoch) throw new WorkReadUnavailable('Feed projection is recovering');
      return new FeedReadFrame(pool, reader?.principal ?? null, reader?.agent ?? null, epoch, owner, row);
    });
  }

  private static async state(client: PoolClient, owner: string | null, agent: string | null,
    actors: string[], full: boolean): Promise<ReaderRow> {
    return (await client.query<ReaderRow>(`SELECT
      to_jsonb(c) || jsonb_build_object('sequence',c.sequence::text,'review_sequence',c.review_sequence::text)
        AS checkpoint, h.revision, h.preferences, languages.content_languages,
      to_jsonb(p) AS settings, f.revision AS following_revision, COALESCE(f.active_count,0) AS following_count,
      to_jsonb(w) || jsonb_build_object('sequence',w.sequence::text) AS watermark,
      ${full ? `COALESCE((SELECT jsonb_agg(e) FROM (SELECT kind,target,strength FROM access.home_exclusion
        WHERE principal_id = $1 ORDER BY kind,target LIMIT ${HOME_COST.exclusions + 1}) e),'[]'::jsonb)` : "'[]'::jsonb"} AS exclusions,
      ${full ? `COALESCE((SELECT jsonb_agg(target_agent ORDER BY target_agent) FROM
        (SELECT target_agent FROM access.person_block WHERE principal_id = $1 ORDER BY target_agent LIMIT 501) b),'[]'::jsonb)` : "'[]'::jsonb"} AS blocks,
      COALESCE((SELECT jsonb_agg(a) FROM (${actorRows}) a),'[]'::jsonb) AS actors,
      (SELECT generation::text FROM access.recovery_fence WHERE id) AS recovery_generation,
      i.sequence::text AS index_sequence, i.revision AS index_revision,
      i.data_epoch IS NOT NULL AND i.after_event='￿' AND NOT EXISTS(SELECT 1 FROM access.feed_item
        WHERE data_epoch=c.data_epoch AND NOT target_indexed LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM access.feed_author_dirty WHERE data_epoch=c.data_epoch LIMIT 1) AS index_complete,
      EXISTS(SELECT 1 FROM access.reader_review_event WHERE sequence > c.review_sequence LIMIT 1) AS pending_reviews
      FROM (SELECT 1) root LEFT JOIN access.feed_checkpoint c ON c.id
      LEFT JOIN access.feed_target_checkpoint i ON i.data_epoch=c.data_epoch
      LEFT JOIN access.home_state h ON h.principal_id = $1
      LEFT JOIN access.follow_inventory f ON f.principal_id = $1
      LEFT JOIN access.person_preferences p ON p.agent_id = $2
      LEFT JOIN (${PRIMARY_READING_PERSON_SQL}) person ON true
      LEFT JOIN access.person_preferences languages ON languages.agent_id = person.agent_id
      LEFT JOIN access.home_watermark w ON w.principal_id = $1 AND w.scope = 'following'`,
    [owner, agent, actors])).rows[0]!;
  }

  get checkpoint(): FeedCheckpoint {
    const c = this.opening.checkpoint!;
    return { ...c, sequence: String(c.sequence), review_sequence: String(c.review_sequence) };
  }
  get personal() {
    if (!this.owner) return null;
    const row = this.opening;
    if (row.exclusions.length > HOME_COST.exclusions || row.blocks.length > 500)
      throw new WorkReadUnavailable('Home inventory exceeds its bound');
    return { owner: this.owner, revision: row.revision,
      preferences: { ...(row.preferences ?? defaultPreferences), contentLanguages: row.content_languages ?? [] },
      exclusions: row.exclusions };
  }
  get personSettings(): PersonPreferences | null {
    if (!this.owner) return null;
    const p = this.opening.settings;
    return { profile: 'person-preferences-v1', ...DEFAULT_PERSON_CHOICES,
      ...(p ? { profileVisibility: p.profile_visibility as PersonPreferences['profileVisibility'],
        followPolicy: p.follow_policy as PersonPreferences['followPolicy'],
        hideReadingActivity: Boolean(p.hide_reading_activity),
        contentLanguages: p.content_languages as string[],
        spoilerPolicy: p.spoiler_policy as PersonPreferences['spoilerPolicy'] } : {}),
      version: Number(p?.version ?? 0), blockedPeople: this.opening.blocks };
  }
  get following() { return this.owner ? { owner: this.owner, revision: this.opening.following_revision,
    count: this.opening.following_count } : null; }
  get watermark() { const w = this.opening.watermark; return w ? { ...w, updated_at: new Date(w.updated_at) } : null; }
  useFollowingIndex() {
    this.usedTargetIndex = true;
  }
  get followingIndexRevision() { return this.opening.index_revision; }
  followingIndexCurrent(sequence: string) {
    return this.opening.index_complete && this.opening.index_sequence !== null
      && BigInt(this.opening.index_sequence) >= BigInt(sequence);
  }

  /** Actor state and all follow reasons share one MVCC statement snapshot. */
  async cardAccess(actors: readonly string[], identities: readonly string[][]) {
    const ids = [...new Set(actors)];
    const rows = (await this.pool.query<{ actors: ActorState[];
      followed: { target: string; kind: FollowKind; identity: string }[] }>(`WITH identities AS (
      SELECT id,COALESCE(a.space,id) AS target FROM unnest($4::text[]) id
      LEFT JOIN access.follow_space_alias a ON a.alias = id)
      SELECT $2::text AS acting_agent, COALESCE((SELECT jsonb_agg(a) FROM (${actorRows}) a),'[]'::jsonb) AS actors,
        COALESCE((SELECT jsonb_agg(m) FROM (SELECT f.target,f.kind,i.id AS identity FROM identities i
          JOIN access.follow f ON (f.target = i.target OR f.target IN
            (SELECT alias FROM access.follow_space_alias WHERE space = i.target))
          WHERE f.principal_id = $1 AND f.following) m),'[]'::jsonb) AS followed`,
    [this.owner, this.agent, ids, [...new Set(identities.flat())]])).rows[0]!;
    this.actors = new Map(rows.actors.map(row => [row.id, row]));
    const match = (keysByCard: readonly string[][]) => this.owner ? {
      ...this.following!, matches: keysByCard.map(keys => keys.some(key => rows.followed.some(row => row.identity === key))),
      reasons: keysByCard.map(keys => keys.flatMap(key => rows.followed.filter(row => row.identity === key)
        .map(({ target, kind }) => ({ target, kind })))) } : null;
    return { actorState: this.actorState, matches: match(identities), match };
  }
  get actorState() {
    const visible = [...this.actors.values()].filter(row => row.profile_visibility !== 'private');
    return { fences: new Map(visible.map(row => [row.id, row.generation])),
      handles: new Map(visible.flatMap(row => row.handle ? [[row.id, row.handle] as const] : [])) };
  }
  get hiddenReadingActors() { return new Set([...this.actors.values()].filter(row => row.hide_reading_activity).map(row => row.id)); }

  async close() {
    return controlRead(this.pool, async client => {
      const owner = this.principal ? await followPrincipal(client, this.principal, this.agent!) : null;
      const current = await FeedReadFrame.state(client, owner, this.agent, [...this.actors.keys()], false);
      if (owner !== this.owner || current.checkpoint?.data_epoch !== this.epoch
        || current.recovery_generation !== this.opening.recovery_generation
        || current.checkpoint.revision !== this.checkpoint.revision || current.revision !== this.opening.revision
        || current.following_revision !== this.opening.following_revision
        || this.usedTargetIndex && current.index_revision !== this.opening.index_revision
        || Number(current.settings?.version ?? 0) !== this.personSettings?.version && this.owner !== null
        || JSON.stringify(current.actors) !== JSON.stringify([...this.actors.values()])) throw new WorkReadMoved('Feed changed');
      return { pending: current.pending_reviews, watermark: this.watermark };
    });
  }
}
