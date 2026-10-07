import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { advanceContentSequence, settledContentPosition } from '../content-sequence.ts';
import {
  completeRenditionLadderSql,
  pixelCrop,
  RENDITION_LIMITS,
  type ImageSize,
} from '../media-rendition/policy.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaConflict, MediaInvalid, MediaMissing } from './contract.ts';
import type { CommandOutcome, MediaAdmission } from './store.ts';
import {
  admitShowcaseImage,
  normalizeTrailer,
  ShowcaseRefused,
  SHOWCASE_LOGO_LANGUAGES,
  showcaseSlot,
  type LogoAnchor,
  type LogoTone,
  type ShowcaseArt,
  type ShowcaseImage,
  type ShowcaseSelectionInput,
  type ShowcaseTrailerInput,
  type CampaignArtInput,
} from './showcase-contract.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
interface SourceBasis {
  revision: string;
  representation: string;
  namespace: string;
  digest: string;
  mediaType: string;
}
type Inspector = (basis: SourceBasis) => Promise<ImageSize & { hasAlpha?: boolean }>;

/** One owner query for <=64 disclosed targets. Two indexed active ranges per
 * target, exact context/head/Use/source probes per role, <=12 candidates per image.
 * Cost is O((B+K) log S + K*C log R), output O(K*C), where K is the selected slots of these
 * targets (including all active logo languages), C<=12. No inventory/history scan or
 * per-target round trip. A requested slot wins even if removed or unreadable. */
export const SHOWCASE_BATCH_SQL = `WITH owner AS (
  SELECT data_epoch,sequence::text FROM content.owner_control WHERE singleton),
  wanted AS (SELECT t.target,c.context FROM unnest($1::text[]) t(target)
    CROSS JOIN unnest($2::text[]) c(context)),
  candidates AS MATERIALIZED (SELECT DISTINCT w.target,s.role
    FROM wanted w JOIN media.selection_slot s ON s.target=w.target AND s.context=w.context
      AND s.role LIKE 'showcase-%' AND s.showcase_active),
  chosen AS (SELECT candidate.target,candidate.role,slot.context,slot.head
    FROM candidates candidate JOIN LATERAL (
      SELECT s.context,s.head FROM unnest($2::text[]) WITH ORDINALITY c(context,rank)
      JOIN media.selection_slot s ON s.target=candidate.target AND s.context=c.context
        AND s.role=candidate.role AND s.role LIKE 'showcase-%'
      ORDER BY c.rank LIMIT 1) slot ON true)
  SELECT o.data_epoch,o.sequence,c.target,c.role,c.context,r.id AS selection,r.trailer_url,
    u.id AS use,u.asset_id,u.crop,u.focal_area,u.logo_anchor,u.oriented_width,u.oriented_height,
    p.id AS representation,p.media_type,p.pixel_width,p.pixel_height,
    candidates.srcset
  FROM owner o LEFT JOIN chosen c ON true
  LEFT JOIN media.selection_revision r ON r.id=c.head
  LEFT JOIN media.use u ON u.id=r.use_id
  LEFT JOIN content.revision revision ON revision.id=u.asset_revision_id AND revision.availability='available'
  LEFT JOIN media.asset a ON a.id=u.asset_id
  LEFT JOIN media.asset_state s ON s.id=a.state_head
  LEFT JOIN media.representation p ON p.id=u.representation_id AND p.availability='available'
    AND s.disclosure='public' AND s.moderation='none' AND s.lifecycle='active'
    AND revision.id IS NOT NULL AND media.delivery_clearance(p)='cleared'
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('url',
    '/v1/media/representations/' || candidate.id || '/bytes?use=' || u.id,
    'type',candidate.media_type,'width',candidate.pixel_width,'height',candidate.pixel_height)
    ORDER BY candidate.pixel_width,candidate.media_type) AS srcset
    FROM (SELECT d.id,d.media_type,d.pixel_width,d.pixel_height FROM media.representation d
      WHERE d.source_id=p.id AND COALESCE(d.crop,'')=COALESCE(u.crop,'')
        AND d.kind='rendition' AND d.availability='available'
        AND d.profile ~ '^image-width-[1-9][0-9]{0,3}-(avif|webp)-v1$'
        AND d.media_type IN ('image/avif','image/webp') AND media.delivery_clearance(d)='cleared'
        AND ${completeRenditionLadderSql('p.id', 'u.crop', 'd')}
      ORDER BY d.pixel_width,d.media_type,d.id LIMIT ${RENDITION_LIMITS.candidates}) candidate
  ) candidates ON p.id IS NOT NULL
  ORDER BY c.target,c.role`;

/** At most two active tones for each of eight languages in this context. */
export const SHOWCASE_LOGO_CAPACITY_SQL = `SELECT array_agg(DISTINCT split_part(role,':',2)) AS languages
  FROM media.selection_slot WHERE target=$1 AND context=$2
    AND role LIKE 'showcase-%' AND role LIKE 'showcase-logo:%' AND showcase_active`;

/** Showcase is an extension of media selections, not a second document owner. */
export class MediaShowcaseStore {
  constructor(private readonly pool: Pool) {}

  /** A campaign keeps its exact Use when another slide creates art of the same
   * role. One operation lock and exact source probes, O(log M) owner work. */
  async createCampaign(admission: MediaAdmission, input: CampaignArtInput,
    inspect: Inspector): Promise<CommandOutcome> {
    const role = showcaseSlot(input).replace(/^showcase-/, 'campaign-');
    if (!NATIVE.test(input.zone) || !NATIVE.test(input.target) || !UUID.test(input.asset)
      || !this.validContext(input.context) || !UUID.test(admission.admissionId)
      || !UUID.test(admission.principalId) || !NATIVE.test(admission.actingSubject)
      || !/^[0-9a-f]{64}$/.test(admission.requestDigest)
      || !/^(0|[1-9][0-9]{0,19})$/.test(admission.authorityEpoch))
      throw new MediaInvalid('invalid campaign art');
    const operation = `media-campaign:${admission.admissionId}`;
    const client = await this.pool.connect();
    let result: Omit<CommandOutcome, 'position'>;
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operation]);
      const prior = (await client.query(`SELECT r.*,u.id FROM content.receipt r
        LEFT JOIN media.use u ON u.operation_id=r.operation_id WHERE r.operation_id=$1`, [operation])).rows[0];
      if (prior) {
        if (prior.request_digest !== admission.requestDigest || prior.action !== 'media.use.create')
          throw new MediaConflict('campaign key binds another intent');
        result = { outcome: prior.outcome, id: prior.id ?? null, predecessor: null, replayed: true };
      } else {
        const source = await this.source(client, input.asset, admission.actingSubject, true);
        const inspected = await inspect(source);
        admitShowcaseImage(input, inspected);
        const id = randomUUID();
        await advanceContentSequence(client, { operationId: operation,
          requestDigest: admission.requestDigest, action: 'media.use.create', outcome: 'succeeded',
          eventType: 'media.use.created', recipe: 'media-v1', payload: { target: input.target, zone: input.zone, use: id } });
        await client.query(`INSERT INTO media.use
          (id,asset_id,asset_variant_id,asset_revision_id,representation_id,target,context,role,crop,
            focal_area,logo_anchor,oriented_width,oriented_height,has_alpha,actor,operation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, input.asset, `urn:rezics:variant:${input.asset}`, source.revision, source.representation,
          input.target, input.context, role, input.crop, input.focalArea, input.anchor ?? null,
          inspected.width, inspected.height, inspected.hasAlpha, admission.actingSubject, operation]);
        result = { outcome: 'succeeded', id, predecessor: null, replayed: false };
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return { ...result, position: await settledContentPosition(this.pool, operation) };
  }

  private async source(client: PoolClient, asset: string, actor: string, publicOnly = false): Promise<SourceBasis> {
    const row = (await client.query(`SELECT v.draft_head AS revision,p.id AS representation,
      a.object_namespace AS namespace,p.byte_digest AS digest,p.media_type AS "mediaType"
      FROM media.asset a JOIN media.asset_state s ON s.id=a.state_head
      JOIN content.variant v ON v.id=a.variant_id
      JOIN content.revision revision ON revision.id=v.draft_head AND revision.availability='available'
      JOIN media.representation p ON p.id::text=revision.body->'representations'->0->>'id'
        AND p.asset_id=a.id AND p.kind='original' AND p.availability='available'
      WHERE a.id=$1 AND a.owner=$2 AND s.lifecycle='active' AND s.moderation='none'
        AND (NOT $3::boolean OR s.disclosure='public')
        AND media.delivery_clearance(p)='cleared' FOR SHARE OF a,p,v`, [asset, actor, publicOnly])).rows[0];
    if (!row) throw new MediaMissing('showcase source is unavailable');
    return row as SourceBasis;
  }

  async select(
    admission: MediaAdmission,
    input: ShowcaseSelectionInput | ShowcaseTrailerInput,
    inspect: Inspector,
  ): Promise<CommandOutcome> {
    const trailer = 'url' in input;
    const role = trailer ? 'showcase-trailer' : showcaseSlot(input);
    const normalized = trailer ? normalizeTrailer(input.url) : null;
    if (
      !NATIVE.test(input.target) ||
      !this.validContext(input.context) ||
      (input.expectedSelection !== null && !UUID.test(input.expectedSelection)) ||
      !UUID.test(admission.admissionId) ||
      !UUID.test(admission.principalId) ||
      !NATIVE.test(admission.actingSubject) ||
      !/^[0-9a-f]{64}$/.test(admission.requestDigest) ||
      !/^(0|[1-9][0-9]{0,19})$/.test(admission.authorityEpoch) ||
      (!trailer &&
        ((input.asset !== null && !UUID.test(input.asset)) ||
          (input.asset === null && (input.crop !== null || input.focalArea !== null))))
    )
      throw new MediaInvalid('invalid showcase selection');
    const operationId = `media-avatar:${admission.admissionId}`;
    const client = await this.pool.connect();
    let result: Omit<CommandOutcome, 'position'>;
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operationId]);
      const prior = (
        await client.query(
          `SELECT r.*,s.id,s.predecessor,o.payload FROM content.receipt r
        LEFT JOIN media.selection_revision s ON s.operation_id=r.operation_id
        JOIN content.outbox o ON o.operation_id=r.operation_id WHERE r.operation_id=$1`,
          [operationId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.request_digest !== admission.requestDigest ||
          prior.action !== 'media.selection.change'
        )
          throw new MediaConflict('selection key binds another intent');
        result = {
          outcome: prior.outcome,
          id: prior.id ?? null,
          predecessor: prior.predecessor ?? prior.payload.current ?? null,
          replayed: true,
        };
      } else {
        if (!trailer && input.role === 'logo')
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `showcase-logo:${input.target}`,
          ]);
        await client.query(
          `INSERT INTO media.selection_slot(target,context,role,policy)
          VALUES ($1,$2,$3,'showcase-selection-v1') ON CONFLICT DO NOTHING`,
          [input.target, input.context, role],
        );
        const head = (
          await client.query(
            `SELECT head FROM media.selection_slot
          WHERE target=$1 AND context=$2 AND role=$3 FOR UPDATE`,
            [input.target, input.context, role],
          )
        ).rows[0].head as string | null;
        if (head !== input.expectedSelection) {
          await this.receipt(client, admission, 'stale_head', {
            target: input.target,
            context: input.context,
            role,
            current: head,
          });
          result = {
            outcome: 'stale_head',
            id: null,
            predecessor: head,
            replayed: false,
          };
        } else {
          if (!trailer && input.role === 'logo' && input.asset !== null)
            await this.admitLogoLanguage(client, input.target, input.context, role);
          let source: SourceBasis | null = null;
          let inspected: (ImageSize & { hasAlpha?: boolean }) | null = null;
          if (!trailer && input.asset !== null) {
            source = await this.source(client, input.asset, admission.actingSubject);
            inspected = await inspect(source);
            admitShowcaseImage(input, inspected);
          }
          const id = randomUUID();
          const use = source ? randomUUID() : null;
          await this.receipt(client, admission, 'succeeded', {
            target: input.target,
            context: input.context,
            role,
            selection: id,
            removed: !source && !normalized,
          });
          if (!trailer && source && inspected)
            await client.query(
              `INSERT INTO media.use
            (id,asset_id,asset_variant_id,asset_revision_id,representation_id,target,context,role,crop,
              focal_area,logo_anchor,oriented_width,oriented_height,has_alpha,actor,operation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [
                use,
                input.asset,
                `urn:rezics:variant:${input.asset}`,
                source.revision,
                source.representation,
                input.target,
                input.context,
                role,
                input.crop,
                input.focalArea,
                input.anchor ?? null,
                inspected.width,
                inspected.height,
                inspected.hasAlpha,
                admission.actingSubject,
                operationId,
              ],
            );
          await client.query(
            `INSERT INTO media.selection_revision
            (id,target,context,role,predecessor,use_id,trailer_url,actor,authority_epoch,operation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              id,
              input.target,
              input.context,
              role,
              head,
              use,
              normalized?.url ?? null,
              admission.actingSubject,
              admission.authorityEpoch,
              operationId,
            ],
          );
          result = { outcome: 'succeeded', id, predecessor: head, replayed: false };
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { ...result, position: await settledContentPosition(this.pool, operationId) };
  }

  /** The caller holds the target lock through commit. Removed slots retain their
   * history but release capacity; either active tone keeps its language counted.
   * The partial index visits only active slots, O(L) for L<=2*SHOWCASE_LOGO_LANGUAGES. */
  private async admitLogoLanguage(
    client: PoolClient,
    target: string,
    context: string,
    role: string,
  ): Promise<void> {
    const { rows } = await client.query(
      SHOWCASE_LOGO_CAPACITY_SQL,
      [target, context],
    );
    const languages: string[] = rows[0].languages ?? [];
    if (!languages.includes(role.split(':')[1]!) && languages.length >= SHOWCASE_LOGO_LANGUAGES)
      throw new ShowcaseRefused('showcase_logo_limit');
  }

  private receipt(
    client: PoolClient,
    admission: MediaAdmission,
    outcome: 'succeeded' | 'stale_head',
    payload: Record<string, unknown>,
  ) {
    return advanceContentSequence(client, {
      operationId: `media-avatar:${admission.admissionId}`,
      requestDigest: admission.requestDigest,
      action: 'media.selection.change',
      outcome,
      ...(outcome === 'stale_head' ? { reason: 'expected selection differs' } : {}),
      eventType: outcome === 'succeeded' ? 'media.selection.changed' : 'media.selection.stale',
      recipe: 'media-v1',
      payload,
    });
  }
  private validContext(context: string) {
    return context === DEFAULT_MEDIA_CONTEXT || NATIVE.test(context);
  }

  /** Lost queue/reconciliation stages replay from the retained selection. Replaced,
   * removed or now hidden sources need no new derivative work. */
  async renditionUse(selection: string): Promise<string | null> {
    const row = (
      await this.pool.query(
        `SELECT u.id FROM media.selection_revision r
      JOIN media.selection_slot slot ON slot.head=r.id AND slot.target=r.target AND slot.context=r.context AND slot.role=r.role
      JOIN media.use u ON u.id=r.use_id JOIN media.asset a ON a.id=u.asset_id
      JOIN media.asset_state s ON s.id=a.state_head JOIN media.representation p ON p.id=u.representation_id
      WHERE r.id=$1 AND r.role LIKE 'showcase-%' AND s.lifecycle='active' AND s.moderation='none'
        AND p.availability='available' AND media.delivery_clearance(p)='cleared'`,
        [selection],
      )
    ).rows[0];
    return row?.id ?? null;
  }

  /** Targets have already passed graph disclosure and Access at the route boundary. */
  async readBatch(targets: readonly string[], context: string) {
    if (
      targets.length > 64 ||
      targets.some((target) => !NATIVE.test(target)) ||
      !this.validContext(context)
    )
      throw new MediaInvalid('invalid showcase batch');
    const contexts =
      context === DEFAULT_MEDIA_CONTEXT ? [context] : [context, DEFAULT_MEDIA_CONTEXT];
    const result = await this.pool.query(SHOWCASE_BATCH_SQL, [[...new Set(targets)], contexts]);
    const art = new Map<string, ShowcaseArt>(
      targets.map((reference) => [
        reference,
        { reference, status: 'available', images: [], trailer: null },
      ]),
    );
    for (const row of result.rows) {
      const item = art.get(row.target);
      if (!item) continue;
      if (row.role === 'showcase-trailer') {
        const trailer = normalizeTrailer(row.trailer_url ?? null);
        if (trailer) item.trailer = { selection: row.selection, context: row.context, ...trailer };
      } else if (row.representation && row.use) {
        const size = pixelCrop(row.crop, {
          width: row.oriented_width,
          height: row.oriented_height,
        });
        const image: ShowcaseImage = {
          role: row.role.slice('showcase-'.length),
          selection: row.selection,
          asset: row.asset_id,
          use: row.use,
          representation: row.representation,
          context: row.context,
          url: `/v1/media/representations/${row.representation}/bytes?use=${row.use}`,
          mediaType: row.media_type,
          width: row.oriented_width,
          height: row.oriented_height,
          cropWidth: size.width,
          cropHeight: size.height,
          crop: row.crop,
          focalArea: row.focal_area,
          srcset: row.srcset ?? [],
        };
        if (row.role.startsWith('showcase-logo:')) {
          const [, language, tone] = (row.role as string).split(':');
          image.role = 'logo';
          image.language = language;
          image.tone = tone as LogoTone;
          image.anchor = row.logo_anchor as LogoAnchor;
        }
        item.images.push(image);
      }
    }
    const owner = result.rows[0];
    return { art, generation: owner ? `${owner.data_epoch}:${owner.sequence}` : null };
  }
}
