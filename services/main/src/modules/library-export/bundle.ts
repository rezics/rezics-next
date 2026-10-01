import type { Pool } from 'pg';
import { emptyRow, FILE_IMPORT_COST, type CanonicalRow } from '../library-import/formats/contract.ts';
import { importDigest, type RowMatch } from '../library-import/file-store.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import type { SessionState } from '../session/contract.ts';

export const LIBRARY_EXPORT_COST = { page: 20, sqlPerPage: 16, graphPerPage: 26,
  phases: 7, responseBytes: FILE_IMPORT_COST.bytes } as const;
type ExportOptions = { limit?: number; cursor?: string; snapshot?: string };
const row = (kind: CanonicalRow['kind'], id: string, work: string | null, raw: Record<string, unknown> = {}) =>
  ({ ...emptyRow(id,'',raw),kind,work });

/** Heterogeneous owner records prevent request-sized attempt/shelf arrays from
 * becoming library limits. Each phase seeks immutable identity keys. A Content
 * owner fence and reader collection/rating heads detect changes before and after every page.
 * The retained cursor lasts 30 minutes and tolerates unrelated graph writes. */
export class LibraryBundleExporter {
  constructor(private readonly content: Pool, private readonly access: Pool) {}
  async fence(session: WorkReadSession, agent: string) {
    const result = await this.content.query<{ data_epoch: string; version: string; expires_at: Date | null }>(`SELECT c.data_epoch,
      coalesce(f.version,0)::text AS version,
      (SELECT min(expires_at) FROM reader.library_import_file WHERE agent=$1 AND expires_at>clock_timestamp()) AS expires_at
      FROM content.owner_control c LEFT JOIN reader.library_bundle_fence f ON f.agent=$1 WHERE c.singleton`,[agent]);
    const position = result.rows[0];
    if (!position) throw new WorkReadUnavailable('Library export position is unavailable');
    const principalId = await session.deps.access.activePrincipalId(session.principal!);
    if (!principalId) throw new WorkReadUnavailable('Library export principal is unavailable');
    const ratings = await this.access.query<{ digest: string }>(`SELECT md5(coalesce(string_agg(
      context||':'||work||':'||revision,'|' ORDER BY context,work),'')) AS digest
      FROM access.rating_aggregate_head WHERE principal_id=$1 AND target_release IS NULL`,[principalId]);
    // Aggregate only this reader's collection heads. Jena preserves the ordered
    // subquery input to GROUP_CONCAT; neither bodies nor memberships are returned.
    const collections = await session.query(`SELECT (SHA256(GROUP_CONCAT(?part; separator="|")) AS ?digest) WHERE {
      { SELECT ?part WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?id a rv:Collection ; rv:curator ${iri(agent)} ; rv:collectionState rv:Active ;
          schema:name ?name ; rv:disclosure ?disclosure ; rv:structure ?structure .
        ?structure rv:selectedGeneration ?generation .
        OPTIONAL { ?id rv:protectionHead ?protection }
        BIND(SHA256(CONCAT(STR(?id),"|",ENCODE_FOR_URI(STR(?name)),"|",STR(?disclosure),"|",STR(?generation),"|",COALESCE(STR(?protection),""))) AS ?part)
      } } ORDER BY ?part }
    } LIMIT 1`,1);
    return { value: importDigest([position.data_epoch,position.version,position.expires_at?.toISOString(),
      ratings.rows[0]?.digest,collections[0]?.digest?.value]),expiresAt: position.expires_at?.getTime() };
  }
  async page(session: WorkReadSession, agent: string, options: ExportOptions) {
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
      if (!Array.isArray(key) || key.length !== 2 || !Number.isInteger(key[0]) || key[0]<0 || key[0]>=7 || typeof key[1] !== 'string') {
        throw new WorkReadInvalid('Invalid library export cursor');
      }
      [phase,after] = key as [number,string];
    }
    const rows: CanonicalRow[] = [];
    let rowBytes = 0;
    while (phase < LIBRARY_EXPORT_COST.phases && rows.length < limit) {
      const page = await this.phase(session,agent,phase,after,limit-rows.length+1);
      const accepted: typeof page = [];
      for (const item of page) {
        const bytes = new TextEncoder().encode(JSON.stringify(item.row)).length + 1;
        if (accepted.length + rows.length >= limit || rowBytes + bytes > LIBRARY_EXPORT_COST.responseBytes - 8192) break;
        accepted.push(item); rowBytes += bytes;
      }
      rows.push(...accepted.map(item => item.row));
      if (page.length > accepted.length) {
        if (accepted.length) after = accepted.at(-1)!.key;
        if (!rows.length) throw new WorkReadInvalid('A library record exceeds the portable export row limit');
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
  private async phase(session: WorkReadSession, agent: string, phase: number, after: string, limit: number): Promise<Array<{ key: string; row: CanonicalRow }>> {
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
      const result = await this.content.query<{ key: string; source: CanonicalRow; private_extras: Record<string,unknown>; match: RowMatch | null; resolution: unknown; outcome: unknown }>(`
        SELECT s.digest AS key,s.source,s.private_extras,r.match,r.resolution,r.outcome
        FROM reader.library_import_source s
        JOIN LATERAL (SELECT r.match,r.resolution,r.outcome FROM reader.library_import_source_row r
          JOIN reader.library_import_file f ON f.agent=r.agent AND f.id=r.file_id
          WHERE r.agent=s.agent AND r.source_digest=s.digest AND f.expires_at>clock_timestamp()
          ORDER BY r.file_id,r.row_number LIMIT 1) r ON true
        WHERE s.agent=$1 AND (s.source->>'kind' IN ('source','retained') OR s.private_extras <> '{}'::jsonb)
          AND s.digest>$2 ORDER BY s.digest LIMIT $3`,[agent,after,limit]);
      return result.rows.map(s => ({ key: s.key,row: s.source.kind === 'retained' ? s.source
        : s.source.kind !== 'source' ? { ...row('retained',`extras:${s.key}`,s.source.work),title: s.source.title,
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
      const member = phase === 5;
      const result = await session.query(`SELECT ?id ?name ?disclosure ${member ? '?work ?placement' : ''} WHERE {
        GRAPH ${iri(GRAPHS.current)} {
          ?id a rv:Collection ; rv:curator ${iri(agent)} ; rv:collectionState rv:Active ;
            schema:name ?name ; rv:disclosure ?disclosure ; rv:structure ?structure .
          ?structure rv:selectedGeneration ?generation .
          ${member ? '?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrenceRole rv:MemberRole ; schema:item ?work .' : ''}
          FILTER NOT EXISTS { ?id rv:protectionHead ?protection }
        }
        FILTER(?disclosure IN (rv:Private,rv:Public))
        FILTER(STR(${member ? '?placement' : '?id'}) > ${lit(after)})
      } ORDER BY STR(${member ? '?placement' : '?id'}) LIMIT ${limit}`,limit);
      return result.map(s => ({ key: (member ? s.placement : s.id)!.value,
        row: { ...row(member ? 'entry' : 'shelf',(member ? s.placement : s.id)!.value,member ? s.work!.value : null,
          { shelfId: s.id!.value,disclosure: s.disclosure!.value === `${RV}Public` ? 'public' : 'private' }),
          title: s.name!.value,shelves: [s.name!.value] } }));
    }
    const principalId = await session.deps.access.activePrincipalId(principal);
    if (!principalId) throw new WorkReadUnavailable('Library export principal is unavailable');
    const result = await this.access.query<{ work: string; context: string; observation: string; revision: string; key: string }>(`
      SELECT work,context,observation,revision,context||':'||work AS key FROM access.rating_aggregate_head
      WHERE principal_id=$1 AND target_release IS NULL AND context||':'||work>$2
      ORDER BY context,work LIMIT $3`,[principalId,after,limit]);
    if (result.rows.length) {
      const reader = await session.deps.account.verify(session.request,['rating:read']);
      if (reader.issuer !== principal.issuer || reader.subject !== principal.subject) throw new WorkReadUnavailable('Rating export principal changed');
    }
    const rows: Array<{ key: string; row: CanonicalRow }> = [];
    for (const h of result.rows) {
      const values = await session.query(`SELECT ?value ?availability ?min ?max WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(h.observation)} rv:observationHead ${iri(h.revision)} ; rv:ratingContext ${iri(h.context)} .
          ${iri(h.context)} rv:ratingScaleMin ?min ; rv:ratingScaleMax ?max . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(h.revision)} rv:ratingAvailability ?availability .
          OPTIONAL { ${iri(h.revision)} rv:ratingValue ?value }
          FILTER NOT EXISTS { ${iri(h.revision)} a rv:ErasedRevision } }
      } LIMIT 2`,2);
      if (values.length !== 1) throw new WorkReadUnavailable('Rating changed or is unavailable during export');
      const v = values[0]!, min = Number(v.min!.value), max = Number(v.max!.value);
      // A withdrawn observation has no score to recreate. Keep its private
      // provenance; never invent a predecessor score to satisfy the rating API.
      rows.push({ key: h.key,row: { ...row(v.value ? 'entry' : 'retained',`rating:${h.key}`,h.work,{ ratingContext: h.context,
        ratingScaleMax: max,ratingAvailability: v.availability!.value === `${RV}Available` ? 'available' : 'withdrawn' }),
        score: v.value ? { value: Number(v.value.value),min,max,step: 1 } : null } });
    }
    return rows;
  }
}
