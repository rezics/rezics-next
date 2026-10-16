import type { Pool, PoolClient } from 'pg';
import { indexedRead } from '../../infrastructure/indexed-read.ts';
import { withAccessClient } from '../access/topology-control.ts';
import { emptyRow, FILE_IMPORT_COST, type CanonicalRow } from '../library-import/formats/contract.ts';
import { importDigest, type RowMatch } from '../library-import/file-store.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { readPersonalProjectionResources, ratingAnnotation } from '../export/scoped.ts';
import { readPersonalRatingEvidence } from '../export/personal-evidence.ts';
import type { SessionState } from '../session/contract.ts';
import type { CopyState } from '../library/copies.ts';
import type { LoanState } from '../library/loans.ts';
import { ownershipJsonLd, loanJsonLd } from './ownership.ts';

export const LIBRARY_EXPORT_COST = { page: 20, sqlPerPage: 20, graphPerPage: WORK_READ_COST.graphCalls,
  phases: 10, scopedRatingsPerPage: 20, responseBytes: FILE_IMPORT_COST.bytes } as const;
// The marker index over-approximates, so the seek stays bounded by it. A source
// is included only when its chosen non-expired row needs an archive, or the
// kind is source or retained, or private extras are not empty. An expired file,
// or a live row that fails that check, is skipped. The page can be short; it
// never reads further to fill, and expiry never adds a row.
export const retainedLibrarySourcePageSql = `SELECT s.digest AS key,s.source,s.private_extras,r.source_view,r.archive_needed,r.match,r.resolution,r.outcome,
  (r.archive_needed OR s.source->>'kind' IN ('source','retained') OR s.private_extras <> '{}'::jsonb) AS included
  FROM (
    SELECT agent,digest,source,private_extras FROM reader.library_import_source
    WHERE agent=$1 AND exportable AND digest>$2 ORDER BY digest LIMIT $3
  ) s
  LEFT JOIN LATERAL (SELECT r.source_view,r.archive_needed,r.match,r.resolution,r.outcome FROM reader.library_import_source_row r
    JOIN reader.library_import_file f ON f.agent=r.agent AND f.id=r.file_id
    WHERE r.agent=s.agent AND r.source_digest=s.digest AND f.expires_at>clock_timestamp()
    ORDER BY r.archive_needed DESC,r.file_id,r.row_number LIMIT 1) r ON true`;
type ExportOptions = { limit?: number; cursor?: string; snapshot?: string };
const row = (kind: CanonicalRow['kind'], id: string, work: string | null, raw: Record<string, unknown> = {}) =>
  ({ ...emptyRow(id,'',raw),kind,work });
function ratingAfter(after: string): [string, string] {
  if (!after) return ['', ''];
  let key: unknown;
  try { key = JSON.parse(after); } catch { throw new WorkReadInvalid('Invalid rating export cursor'); }
  if (!Array.isArray(key) || key.length !== 2 || key.some(value => typeof value !== 'string')) {
    throw new WorkReadInvalid('Invalid rating export cursor');
  }
  return key as [string, string];
}

/** Heterogeneous owner records prevent request-sized attempt/shelf arrays from
 * becoming library limits. Each phase seeks immutable identity keys. A Content
 * owner fence and reader collection/rating heads detect changes before and after every page.
 * The retained cursor lasts 30 minutes and tolerates unrelated graph writes. */
export class LibraryBundleExporter {
  constructor(private readonly content: Pool | PoolClient, private readonly access: Pool | PoolClient) {}
  async fence(session: WorkReadSession, agent: string) {
    const result = await this.content.query<{ data_epoch: string; version: string; expires_at: Date | null }>(`SELECT c.data_epoch,
      coalesce(f.version,0)::text AS version,
      (SELECT min(expires_at) FROM reader.library_import_file WHERE agent=$1 AND expires_at>clock_timestamp()) AS expires_at
      FROM content.owner_control c LEFT JOIN reader.library_bundle_fence f ON f.agent=$1 WHERE c.singleton`,[agent]);
    const position = result.rows[0];
    if (!position) throw new WorkReadUnavailable('Library export position is unavailable');
    const principalId = await session.deps.access.activePrincipalId(session.principal!);
    if (!principalId) throw new WorkReadUnavailable('Library export principal is unavailable');
    const ratings = await this.access.query<{ version: string }>(`SELECT library_rating_version::text AS version
      FROM access.principal WHERE id=$1 AND active`,[principalId]);
    if (ratings.rows.length !== 1) throw new WorkReadUnavailable('Library export principal is unavailable');
    const collections = await session.query(`SELECT ?position WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(agent)} rv:libraryCollectionPosition ?position
    } } LIMIT 2`,1);
    return { value: importDigest([position.data_epoch,position.version,position.expires_at?.toISOString(),
      ratings.rows[0]!.version,collections[0]?.position?.value ?? null]),expiresAt: position.expires_at?.getTime() };
  }
  async page(session: WorkReadSession, agent: string, options: ExportOptions) {
    // One index scope per database covers every phase, including sparse ones.
    // Reopening a scope per phase would spend the SQL budget on planner setup.
    // Admission and selected-evidence fences must join this same Access checkout.
    // Their FOR SHARE recovery/authority locks require a read-write transaction.
    const read = (access: PoolClient) => indexedRead(this.content, content =>
      indexedRead(access, client => new LibraryBundleExporter(content, client)
        .readPage(session, agent, options), 'write'));
    return 'release' in this.access ? read(this.access) : withAccessClient(this.access, read);
  }
  private async readPage(session: WorkReadSession, agent: string, options: ExportOptions) {
    if (!session.principal) throw new WorkReadInvalid('Authentication is required');
    const limit = options.limit ?? LIBRARY_EXPORT_COST.page;
    const owner = await this.fence(session,agent), fence = owner.value, binding = ['rezics-library-export-v1',session.principal.issuer,session.principal.subject,agent];
    const basis = decodeReadCursor(options.snapshot,binding,session.position,true);
    if (basis && basis.order !== fence) throw new WorkReadMoved('Library changed; start a new export');
    const cursor = decodeReadCursor(options.cursor,binding,session.position,true);
    if (cursor && (!basis || cursor.order !== fence)) throw new WorkReadMoved('Library changed or snapshot is missing; start a new export');
    const expiresAt = basis?.expiresAt ?? Math.min(Date.now()+30*60*1000,owner.expiresAt ?? Infinity);
    let phase = 0, after = '';
    if (cursor) {
      let key: unknown;
      try { key = JSON.parse(cursor.after); } catch { throw new WorkReadInvalid('Invalid library export cursor'); }
      if (!Array.isArray(key) || key.length !== 2 || !Number.isInteger(key[0]) || key[0]<0 || key[0]>=LIBRARY_EXPORT_COST.phases || typeof key[1] !== 'string') {
        throw new WorkReadInvalid('Invalid library export cursor');
      }
      [phase,after] = key as [number,string];
    }
    const rows: CanonicalRow[] = [];
    let rowBytes = 0;
    while (phase < LIBRARY_EXPORT_COST.phases && rows.length < limit) {
      // Bound exact scoped-record hydration without limiting the traversable inventory.
      const pageLimit = limit;
      const requested = pageLimit-rows.length+1;
      const page = await this.phase(session,agent,phase,after,requested);
      const accepted: Array<{ key: string; row: CanonicalRow }> = [];
      let index = 0;
      for (; index < page.length; index++) {
        const item = page[index]!;
        // A marked source with no live row, or whose chosen live row fails the
        // export predicate, was already counted by the seek. Skipping it must
        // not pull another source into this page.
        if (!item.row) continue;
        const bytes = new TextEncoder().encode(JSON.stringify(item.row)).length + 1;
        if (accepted.length + rows.length >= pageLimit || rowBytes + bytes > LIBRARY_EXPORT_COST.responseBytes - 8192) break;
        accepted.push({ key: item.key, row: item.row }); rowBytes += bytes;
      }
      rows.push(...accepted.map(item => item.row));
      if (index < page.length) {
        if (accepted.length) after = accepted.at(-1)!.key;
        if (!rows.length) throw new WorkReadInvalid('A library record exceeds the portable export row limit');
        break;
      }
      if (page.length === requested) {
        // The seek window was full. Expiry, or a marked source whose live row
        // fails the export predicate, can leave this response short. The next
        // page continues after the last source examined.
        after = page.at(-1)!.key;
        break;
      }
      phase++; after = '';
    }
    if ((await this.fence(session,agent)).value !== fence || !await session.deps.access.canReadAsBaselineMember?.(session.principal,agent)) {
      throw new WorkReadMoved('Library changed during export; start a new export');
    }
    const value = { profile: 'rezics-library-export-v1' as const, rows,
      snapshot: options.snapshot ?? encodeReadCursor(binding,session.position,'snapshot',fence,expiresAt),
      nextCursor: phase<LIBRARY_EXPORT_COST.phases ? encodeReadCursor(binding,session.position,JSON.stringify([phase,after]),fence,expiresAt) : null };
    if (new TextEncoder().encode(JSON.stringify(value)).length > LIBRARY_EXPORT_COST.responseBytes) {
      throw new WorkReadInvalid('Export page is too large; request a smaller limit');
    }
    return value;
  }
  private async phase(session: WorkReadSession, agent: string, phase: number, after: string, limit: number): Promise<Array<{ key: string; row: CanonicalRow | null }>> {
    const principal = session.principal!;
    if (phase === 0) {
      if (after && !/^[1-9][0-9]*$/.test(after)) throw new WorkReadInvalid('Invalid attempt export cursor');
      const result = await this.content.query<{ id: string; state: SessionState; key: string }>(`SELECT id,state,attempt_order::text AS key FROM reader.consumption_session
        WHERE agent=$1 AND principal_issuer=$2 AND principal_subject=$3 AND attempt_order>$4::bigint ORDER BY attempt_order LIMIT $5`,
      [agent,principal.issuer,principal.subject,after || '0',limit]);
      return result.rows.map(({ id,state,key }) => ({ key,row: { ...row('session',id,state.target.work,{ nativeSession: state }),
        session: { target: state.target.resource,state: state.state,startedOn: state.startedOn,finishedOn: state.finishedOn,
          selections: state.selections.map(s => ({ target: s.target.resource,language: s.language,format: s.format })),locators: state.locators } } }));
    }
    if (phase === 1) {
      const result = await this.content.query<{ work: string; status: CanonicalRow['status']; started_on: string | null; finished_on: string | null; session_projection: string | null }>(`
        SELECT work,status,started_on::text,finished_on::text,session_projection FROM reader.library_status
        WHERE agent=$1 AND work>$2 ORDER BY work LIMIT $3`,[agent,after,limit]);
      return result.rows.map(s => ({ key: s.work,row: { ...row('entry',`status:${s.work}`,s.work,{ sessionProjection: s.session_projection }),
        status: s.status,startedOn: s.started_on,finishedOn: s.finished_on } }));
    }
    if (phase === 2) {
      const result = await this.content.query<{ work: string; body: string; language: string; spoiler: boolean }>(`
        SELECT work,body,language,spoiler FROM reader.private_import_review WHERE agent=$1 AND work>$2 ORDER BY work LIMIT $3`,[agent,after,limit]);
      return result.rows.map(r => ({ key: r.work,row: { ...row('entry',`review:${r.work}`,r.work),
        review: { text: r.body,language: r.language,spoiler: r.spoiler } } }));
    }
    if (phase === 3) {
      const result = await this.content.query<{ key: string; source: CanonicalRow; source_view: CanonicalRow | null; archive_needed: boolean | null; included: boolean | null; private_extras: Record<string,unknown>; match: RowMatch | null; resolution: unknown; outcome: unknown }>(
        retainedLibrarySourcePageSql,[agent,after,limit]);
      return result.rows.map(s => ({ key: s.key,row: s.archive_needed == null || s.included !== true ? null
        : s.source_view ? { ...s.source_view,raw: { ...s.source_view.raw,source: s.source } }
        : s.source.kind === 'retained' ? s.source
        : s.source.kind !== 'source' && !s.archive_needed ? { ...row('retained',`extras:${s.key}`,s.source.work),title: s.source.title,
          raw: { sourceId: s.source.sourceId,fields: s.private_extras } }
        : { ...row('retained',`source:${s.key}`,s.source.work),title: s.source.title,
          // Search suggestions are reproducible catalogue data, not the reader's
          // source. Preserve the chosen decision and source without an unbounded
          // candidate-title envelope.
          raw: { source: s.source,match: s.match && { kind: s.match.kind,work: s.match.work,target: s.match.target,
            truncated: s.match.truncated,openLibraryAvailability: s.match.openLibraryAvailability },
          resolution: s.resolution,outcome: s.outcome } } }));
    }
    if (phase === 4 || phase === 5) {
      const result = await session.deps.environment.fuseki.templateIndex({
        operation: 'library-export-page', agent, phase, after, limit });
      if (result.position.dataEpoch !== session.position.dataEpoch || result.rows.length > limit) {
        throw new WorkReadMoved('Library export inventory changed');
      }
      return result.rows.map(item => ({ key: item.key, row: item.kind === 'skip' ? null
        : { ...row(item.kind === 'member' ? 'entry' : 'shelf',
          item.kind === 'member' ? item.placement! : item.collection!, item.work ?? null,
          { shelfId: item.collection!, disclosure: item.disclosure! }), title: item.name!, shelves: [item.name!] } }));
    }
    if (phase === 8) {
      const result = await this.content.query<{ id: string; state: CopyState }>(`SELECT id,state FROM reader.library_copy
        WHERE agent=$1 AND id>$2 ORDER BY id LIMIT $3`, [agent,after,limit]);
      return result.rows.map(copy => ({ key: copy.id,
        row: { ...row('retained',`copy:${copy.id}`,copy.state.work,
          { libraryCopy: copy.state,jsonLd: ownershipJsonLd(copy.state) }),target: copy.state.release } }));
    }
    if (phase === 9) {
      const result = await this.content.query<{ id: string; state: LoanState; work: string; release: string }>(`
        SELECT l.id,l.state,c.work,c.release FROM reader.library_loan l
        JOIN reader.library_copy c ON c.agent=l.agent AND c.id=l.copy
        WHERE l.agent=$1 AND l.id>$2 ORDER BY l.id LIMIT $3`, [agent,after,limit]);
      return result.rows.map(loan => ({ key: loan.id,
        row: { ...row('retained',`loan:${loan.id}`,loan.work,
          { libraryLoan: loan.state,jsonLd: loanJsonLd(loan.state,agent) }),target: loan.release } }));
    }
    const principalId = await session.deps.access.activePrincipalId(principal);
    if (!principalId) throw new WorkReadUnavailable('Library export principal is unavailable');
    if (phase === 7) {
      const result = await this.access.query<{
        target: string;
        context: string;
        observation: string;
        revision: string;
        key: string;
      }>(
        `
        SELECT target,context,observation,revision,context||':'||target AS key FROM access.target_rating_head
        WHERE principal_id=$1 AND (context COLLATE "C",target COLLATE "C")>($2,$3)
        ORDER BY context COLLATE "C",target COLLATE "C" LIMIT $4`,
        [principalId, ...ratingAfter(after), limit],
      );
      if (result.rows.length) {
        const reader = await session.deps.account.verify(session.request, ['rating:read']);
        if (reader.issuer !== principal.issuer || reader.subject !== principal.subject)
          throw new WorkReadUnavailable('Rating export principal changed');
      }
      const exported: Array<{ key: string; row: CanonicalRow }> = [];
      if (result.rows.length) {
        const live = await session.query(
          `SELECT ?observation ?head WHERE {
          VALUES ?observation { ${result.rows.map(head => iri(head.observation)).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?observation rv:observationHead ?head } } LIMIT ${result.rows.length + 1}`,
          result.rows.length,
        );
        if (live.length !== result.rows.length || result.rows.some(head =>
          live.filter(row => row.observation?.value === head.observation && row.head?.value === head.revision).length !== 1))
          throw new WorkReadUnavailable('Target rating head changed during export');
      }
      const evidence = await readPersonalRatingEvidence(session, principalId, result.rows);
      const projectionTargets = [...new Set(evidence.flatMap(({ head, context }) =>
        context?.targetGrain === 'projection' ? [head.target] : []))];
      const projections = await readPersonalProjectionResources(session, projectionTargets);
      for (const { head, rating, context } of evidence) {
        // An erased revision still names this person's row. Record the loss so
        // one unreadable body does not stop the rest of the export.
        if (!rating) {
          exported.push({
            key: head.key,
            row: {
              ...row('retained', `target-rating:${head.key}`, null),
              target: head.target,
              raw: {
                ratingContext: head.context,
                observationRevision: head.revision,
                residuals: [{ kind: 'rating_unavailable', path: '/annotation/oa:hasBody',
                  detail: { reason: 'Rating revision is unavailable' } }],
              },
            },
          });
          continue;
        }
        // Preserve a withdrawal as provenance without fabricating an assessing body.
        let target: string | Record<string, unknown> = head.target;
        const residuals: Array<{ kind: string; path: string; detail: Record<string, unknown> }> = [];
        if (!context) {
          residuals.push({ kind: 'context_unavailable', path: '/annotation/oa:hasBody',
            detail: { reason: 'RatingContext is unavailable' } });
        } else if (context.targetGrain === 'projection') {
          const representation = projections.get(head.target);
          if (representation) target = representation;
          else {
            residuals.push({ kind: 'private_dependency', path: '/annotation/oa:hasTarget',
              detail: { reason: 'Projection parts are unavailable' } });
          }
        }
        const annotation =
          rating.value === null || !context
            ? null
            : ratingAnnotation({
                ...head,
                question: context.question,
                language: context.language,
                value: Number(rating.value),
                scale: context.scale,
                target,
              });
        exported.push({
          key: head.key,
          row: {
            ...row('retained', `target-rating:${head.key}`, null),
            target: head.target,
            raw: {
              ratingContext: head.context,
              observationRevision: head.revision,
              ratingAvailability: rating.availability,
              ratingValue: rating.value,
              ...(annotation ? { annotation } : rating.value === null ? { residual: 'withdrawn-rating' } : {}),
              ...(residuals.length ? { residuals } : {}),
            },
          },
        });
      }
      const keys = new Map(result.rows.map(head => [head.key, JSON.stringify([head.context, head.target])]));
      return exported.map(item => ({ ...item, key: keys.get(item.key)! }));
    }
    const result = await this.access.query<{ work: string; context: string; observation: string; revision: string; key: string }>(`
      SELECT work,context,observation,revision,context||':'||work AS key FROM access.rating_aggregate_head
      WHERE principal_id=$1 AND target_release IS NULL AND (context COLLATE "C",work COLLATE "C")>($2,$3)
      ORDER BY context COLLATE "C",work COLLATE "C" LIMIT $4`,[principalId,...ratingAfter(after),limit]);
    if (result.rows.length) {
      const reader = await session.deps.account.verify(session.request,['rating:read']);
      if (reader.issuer !== principal.issuer || reader.subject !== principal.subject) throw new WorkReadUnavailable('Rating export principal changed');
    }
    const values = result.rows.length ? await session.query(`SELECT ?observation ?value ?availability ?min ?max ?step WHERE {
      VALUES (?observation ?revision ?context) { ${result.rows.map(h => `(${iri(h.observation)} ${iri(h.revision)} ${iri(h.context)})`).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?observation rv:observationHead ?revision ; rv:ratingContext ?context .
        OPTIONAL { ?context rv:contextState rv:Active ; rv:ratingScaleMin ?min ; rv:ratingScaleMax ?max .
          OPTIONAL { ?context rv:ratingScaleStep ?step }
          FILTER NOT EXISTS { ?context rv:protectionHead ?protection } } }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:ratingAvailability ?availability .
        OPTIONAL { ?revision rv:ratingValue ?value }
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    } LIMIT ${result.rows.length * 2 + 1}`,result.rows.length * 2) : [];
    const rows: Array<{ key: string; row: CanonicalRow }> = [];
    for (const h of result.rows) {
      const own = values.filter(value => value.observation?.value === h.observation);
      if (own.length !== 1) throw new WorkReadUnavailable('Rating changed or is unavailable during export');
      const v = own[0]!, min = v.min ? Number(v.min.value) : null, max = v.max ? Number(v.max.value) : null;
      const contextAvailable = min !== null && max !== null;
      // A withdrawn observation has no score to recreate. Keep its private
      // provenance; never invent a predecessor score to satisfy the rating API.
      rows.push({ key: JSON.stringify([h.context,h.work]),row: { ...row(v.value && contextAvailable ? 'entry' : 'retained',`rating:${h.key}`,h.work,{ ratingContext: h.context,
        ratingScaleMax: max,ratingAvailability: v.availability!.value === `${RV}Available` ? 'available' : 'withdrawn',
        ...(!contextAvailable ? { observationRevision: h.revision, ratingValue: v.value ? Number(v.value.value) : null,
          residuals: [{ kind: 'context_unavailable', path: '/score', detail: { reason: 'RatingContext is unavailable' } }] } : {}) }),
        score: v.value && min !== null && max !== null ? { value: Number(v.value.value),min,max,step: Number(v.step?.value ?? 1) } : null } });
    }
    return rows;
  }
}
