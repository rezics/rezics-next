import type { Pool, PoolClient } from 'pg';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { dimensionOfTypes, slotOf, type Coordinate } from '../projection/dimension.ts';
import { runMainRelay } from '../outbox/worker.ts';
import { lockAccessKey } from '../access/scope-gates.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/global.ts';
import { StatementPublicationSeek, type StatementPublicationBasis,
  type StatementPublicationReference, type StatementPublicationPhysicalCursor } from './publication-seek.ts';
import type { StatementPublicationNativeResult } from '../../infrastructure/fuseki.ts';

export const STATEMENT_SEEK_COST = { candidates: 20, frameChannels: 256, visitedRows: 4096,
  projectionSequences: 64, rebuildBatch: 128, projectionReferences: 8192, responseBytes: 1024 * 1024 } as const;
export interface StatementSeekReference { subject: string; predicate: string; meaningKey: string;
  statementId: string; head: string; applicability: { slot: string; iri: string }[] | null }
export interface StatementSeekOrder { predicate: string; meaningKey: string; statementId: string; score: number }
export interface StatementSeekCandidate extends StatementSeekOrder {}
interface Row { subject: string; predicate: string; meaning_key: string; statement_id: string;
  frame_refs: { slot: string; iri: string }[] }
const frameKey = (values: readonly { slot: string; iri: string }[]) => JSON.stringify(
  [...values].sort((a,b) => a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0).map(value => [value.slot,value.iri]));
const compare = (a: StatementSeekOrder,b: StatementSeekOrder) => b.score-a.score
  // Access uses C collation: UTF-8 byte order, including non-BMP IRIs.
  || Buffer.compare(Buffer.from(a.predicate),Buffer.from(b.predicate))
  || (a.meaningKey < b.meaningKey ? -1 : a.meaningKey > b.meaningKey ? 1 : 0)
  || (a.statementId < b.statementId ? -1 : a.statementId > b.statementId ? 1 : 0);

/** Finite OR alternatives per dimension, AND across dimensions. Unknown coordinates
 * remain in the ordinary inventory, but cannot establish frame coverage. */
export function statementFrameKeys(refs: StatementSeekReference['applicability']): string[] {
  if (refs === null || refs.some(ref => ref.slot === 'unknown')) return [];
  const slots = new Map<string, typeof refs>();
  for (const ref of refs) slots.set(ref.slot,[...slots.get(ref.slot) ?? [],ref]);
  let combinations: typeof refs[] = [[]];
  for (const values of slots.values()) combinations = combinations.flatMap(prior => values.map(value => [...prior,value]));
  return [...new Set(combinations.map(frameKey))];
}
export function statementFrameChannels(frames: readonly Coordinate[]) {
  const slots = new Map<string, { exact: string; allowed: string[] }>();
  for (const frame of frames) slots.set(slotOf(frame.dimension), { exact: frame.iri, allowed: [frame.iri] });
  const structure = slots.get('structure');
  const inherited = frames.flatMap(frame => [
    ...(frame.dimension !== 'work' && frame.work ? [frame.work] : []), ...frame.ancestors ?? []]);
  if (structure) structure.allowed.push(...inherited);
  else if (inherited.length) slots.set('structure',{ exact: '',allowed: inherited });
  if (!slots.has('continuity')) {
    const continuities = [...new Set(frames.flatMap(frame => frame.continuities ?? []))];
    if (continuities.length) slots.set('continuity',{ exact: '',allowed: continuities });
  }
  let channels: { refs: { slot: string; iri: string }[]; score: number }[] = [{refs: [],score: 0}];
  for (const [slot, value] of slots) {
    channels = channels.flatMap(prior => [prior,...[...new Set(value.allowed)].map(iri => ({
      refs: [...prior.refs,{slot,iri}],score: prior.score+16+(iri === value.exact ? 1 : 0) }))]);
    if (channels.length > STATEMENT_SEEK_COST.frameChannels) throw new WorkReadUnavailable('Frame seek exceeds its channel bound');
  }
  return { slots,channels: channels.map(channel => ({key: frameKey(channel.refs),score: channel.score})) };
}

/** Equality on epoch/subject and a row-value inequality reach the B-tree leaf
 * directly: https://www.postgresql.org/docs/current/indexes-multicolumn.html.
 * Frame postings use the same ordering inside each fixed reference channel;
 * their bounded merge retains specificity before predicate/meaning/Statement. */
export class StatementSeek {
  constructor(private readonly pool: Pool,private readonly env: WorkActivationEnvironment) {
    this.publication = new StatementPublicationSeek(pool);
  }
  /** One receipted Claim fold adds one exact reference on its held, unchanged cut. */
  async projectClaimFold(claim: string, revision: string, marker: string, mapDigest: string,
    deadline = performance.now()+30_000) {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} ; rv:restoreHold true ; rv:sequence ?sequence .
        ${iri(marker)} rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(mapDigest)} }
      GRAPH ${iri(GRAPHS.current)} { ${iri(claim)} a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ;
        rv:head ${iri(revision)} ; rv:retainedClaimHead ?source }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementRevision ;
        rv:component ${iri(claim)} ; rv:retainedSourceRevision ?source }
    } LIMIT 2`,STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.sequence) throw new WorkReadUnavailable('Claim fold seek source is unavailable');
    const references = await this.readReferences([claim]);
    if (references.length !== 1) throw new WorkReadUnavailable('Claim fold seek reference is incomplete');
    const client = await this.pool.connect();
    try {
      if (performance.now() >= deadline) throw new WorkReadUnavailable('Claim fold seek deadline expired');
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1,Math.floor(deadline-performance.now()))}ms'`);
      await client.query("SET LOCAL lock_timeout = '1s'");
      const fence = await client.query<{open:boolean}>('SELECT open FROM access.recovery_fence WHERE id FOR SHARE');
      const coverage = await client.query<{complete:boolean;through_sequence:string}>(
        'SELECT complete,through_sequence::text FROM access.statement_seek_coverage WHERE data_epoch=$1 FOR UPDATE',[this.env.lineage.dataEpoch]);
      if (fence.rows[0]?.open !== false || !coverage.rows[0]?.complete
        || coverage.rows[0].through_sequence !== rows[0].sequence.value) {
        throw new WorkReadUnavailable('Claim fold requires complete held Statement seek baseline');
      }
      await this.replace(client,references[0]!,this.env.lineage.dataEpoch);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private readonly publication: StatementPublicationSeek;
  private publicationAfter = '';

  async capturePublicationBasis(subject: string): Promise<StatementPublicationBasis | null> {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?membership ?globalFacts WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} .
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
        OPTIONAL { GRAPH ${iri(GRAPHS.control)} {
          ${iri(subject)} rv:statementPublicationMembershipHead ?membership } }
        BIND(EXISTS { { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ?anyPredicate ?anyObject } }
          UNION { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ?anyPredicate ?anyObject } } AS ?globalFacts)
      } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !['true','false'].includes(rows[0]?.globalFacts?.value ?? '')
      || rows[0]?.membership && rows[0].membership.type !== 'uri')
      throw new WorkReadUnavailable('Publication source basis is unavailable');
    if (rows[0]!.globalFacts!.value !== 'false') return null;
    const fence = (await this.pool.query<{generation: string; open: boolean}>(
      'SELECT generation::text,open FROM access.recovery_fence WHERE id=true')).rows[0];
    if (!fence?.open || !/^(0|[1-9][0-9]*)$/.test(fence.generation))
      throw new WorkReadUnavailable('Publication recovery basis is unavailable');
    const source = {dataEpoch: this.env.lineage.dataEpoch,subject,membershipHead: rows[0]!.membership?.value ?? null};
    const native = await this.nativePublicationPage(source,'basis');
    if (native.complete || native.after !== null || native.examined !== 0 || native.references.length)
      throw new WorkReadUnavailable('Publication source capture is invalid');
    return {...source,recoveryBasis: fence.generation,global: 'no-current-facts',sourceStore: native.basis.storage};
  }
  private samePublicationBasis(left: StatementPublicationBasis, right: StatementPublicationBasis | null) {
    return right !== null && left.dataEpoch === right.dataEpoch && left.subject === right.subject
      && left.membershipHead === right.membershipHead && left.recoveryBasis === right.recoveryBasis
      && left.sourceStore === right.sourceStore
      && right.global === 'no-current-facts';
  }
  async requirePublicationCoverage(basis: StatementPublicationBasis) {
    const current = await this.publication.checkpoint(basis);
    if (current?.complete) {
      await this.verifyPublicationEof(basis,current.physicalAfter);
      return;
    }
    await this.publication.begin(basis);
    throw new WorkReadUnavailable('Publication subject reconstruction is pending');
  }
  async seekPotentialPublication(basis: StatementPublicationBasis, after: StatementSeekOrder | null) {
    return this.publication.seek(basis,after);
  }
  async fencePublicationBasis(basis: StatementPublicationBasis) {
    if (!this.samePublicationBasis(basis,await this.capturePublicationBasis(basis.subject)))
      throw new WorkReadUnavailable('Publication source basis moved');
    const current = await this.publication.checkpoint(basis);
    if (!current?.complete) throw new WorkReadUnavailable('Publication local coverage moved');
    await this.verifyPublicationEof(basis,current.physicalAfter);
  }

  private async nativePublicationPage(basis: Pick<StatementPublicationBasis,'dataEpoch' | 'subject' | 'membershipHead'>,
    after: StatementPublicationPhysicalCursor | 'basis' | null): Promise<StatementPublicationNativeResult> {
    try {
      const page = await this.env.fuseki.templateIndex({operation: 'statement-publication-page',
        dataEpoch: basis.dataEpoch,routingEpoch: this.env.lineage.routingEpoch,subject: basis.subject,
        membershipHead: basis.membershipHead,after});
      if (page.basis?.dataEpoch !== basis.dataEpoch || page.basis.routingEpoch !== this.env.lineage.routingEpoch
        || page.basis.subject !== basis.subject || page.basis.membershipHead !== basis.membershipHead
        || typeof page.basis.storage !== 'string' || !page.basis.storage || page.basis.storage.length > 500
        || !Number.isInteger(page.examined) || page.examined < 0 || page.examined > 128
        || !Number.isInteger(page.witnessTuples) || page.witnessTuples < 0 || page.witnessTuples > 8192
        || !Array.isArray(page.references) || page.references.length > 127 || typeof page.complete !== 'boolean'
        || after !== 'basis' && (!page.after || page.after.storage !== page.basis.storage))
        throw new WorkReadUnavailable('Publication native page is invalid');
      return page;
    } catch (error) {
      if (error instanceof WorkReadUnavailable) throw error;
      throw new WorkReadUnavailable('Publication native source is unavailable');
    }
  }
  private async verifyPublicationEof(basis: StatementPublicationBasis, token: StatementPublicationPhysicalCursor | null) {
    if (!token || token.phase !== 2 || token.storage !== basis.sourceStore)
      throw new WorkReadUnavailable('Publication native EOF is missing');
    const page = await this.nativePublicationPage(basis,token);
    if (!page.complete || page.examined !== 0 || page.references.length || page.basis.storage !== basis.sourceStore
      || page.after?.storage !== token.storage || page.after.phase !== token.phase
      || page.after.key !== token.key || page.after.seal !== token.seal)
      throw new WorkReadUnavailable('Publication native EOF moved');
  }
  /** Native prefix progress is independent from SQL candidate result ordering. */
  private async publicationSourcePage(basis: StatementPublicationBasis, after: StatementPublicationPhysicalCursor | null) {
    const page = await this.nativePublicationPage(basis,after);
    if (page.basis.storage !== basis.sourceStore || !page.after)
      throw new WorkReadUnavailable('Publication source store moved');
    const unique = new Map(page.references.map(ref => [ref.statementId,ref]));
    const raw = new Map((await this.readReferences([...unique.keys()])).map(ref => [ref.statementId,ref]));
    const entries = [...unique.values()].map((row): StatementPublicationReference => {
      const ref = raw.get(row.statementId);
      if (!ref || ref.subject !== basis.subject || row.subject !== basis.subject || ref.predicate !== row.predicate
        || ref.meaningKey !== row.meaningKey || ref.head !== row.head
        || JSON.stringify([...row.applicability].sort()) !== JSON.stringify((ref.applicability ?? []).map(value => value.iri).sort()))
        throw new WorkReadUnavailable('Publication current references differ');
      return {subject: ref.subject,predicate: ref.predicate,meaningKey: ref.meaningKey,statementId: ref.statementId,
        head: ref.head,source: row.source,hasEvidence: row.hasEvidence,frameRefs: ref.applicability ?? []};
    });
    return {entries,after: page.after,rawExamined: page.examined,exhausted: page.complete};
  }
  /** One local checkpoint step per existing worker tick; raw replay cannot
   * prevent it because this step commits before the raw projector is attempted. */
  async projectPublicationOnce(): Promise<boolean> {
    let pending = (await this.pool.query<{subject: string}>(`SELECT subject
      FROM access.statement_publication_seek_coverage WHERE data_epoch=$1 AND NOT complete AND subject>$2
      ORDER BY subject LIMIT 1`,[this.env.lineage.dataEpoch,this.publicationAfter])).rows[0];
    if (!pending && this.publicationAfter) {
      this.publicationAfter = '';
      pending = (await this.pool.query<{subject: string}>(`SELECT subject
        FROM access.statement_publication_seek_coverage WHERE data_epoch=$1 AND NOT complete AND subject>$2
        ORDER BY subject LIMIT 1`,[this.env.lineage.dataEpoch,this.publicationAfter])).rows[0];
    }
    if (!pending) return false;
    this.publicationAfter = pending.subject;
    const basis = await this.capturePublicationBasis(pending.subject);
    if (!basis) return false;
    const checkpoint = await this.publication.begin(basis);
    if (checkpoint.complete) return false;
    if (checkpoint.phase === 'clearing') await this.publication.clearBatch(checkpoint);
    else {
      const page = await this.publicationSourcePage(basis,checkpoint.physicalAfter);
      await this.publication.append(checkpoint,page.entries,page,async () => {
        if (!this.samePublicationBasis(basis,await this.capturePublicationBasis(basis.subject))) return false;
        if (page.exhausted) await this.verifyPublicationEof(basis,page.after);
        return true;
      });
    }
    return true;
  }
  async projectWithPublication(): Promise<boolean> {
    const publication = await this.projectPublicationOnce();
    const raw = await this.projectOnce();
    return publication || raw;
  }

  async coverage() {
    const result = await this.pool.query<{ through_sequence: string; complete: boolean }>(
      'SELECT through_sequence::text,complete FROM access.statement_seek_coverage WHERE data_epoch=$1',[this.env.lineage.dataEpoch]);
    return result.rows[0] ?? null;
  }
  async seek(position: {dataEpoch: string; sequence: string},subject: string,
    after: StatementSeekOrder | null,frames?: readonly Coordinate[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const coverage = await client.query<{through_sequence: string; complete: boolean}>(
        'SELECT through_sequence::text,complete FROM access.statement_seek_coverage WHERE data_epoch=$1',[position.dataEpoch]);
      if (position.dataEpoch !== this.env.lineage.dataEpoch || !coverage.rows[0]?.complete
        || coverage.rows[0].through_sequence !== position.sequence) throw new WorkReadUnavailable('Statement seek coverage is unavailable');
      const frame = frames ? statementFrameChannels(frames) : null;
      const channels = (frame?.channels ?? [{key: '*',score: 0}]).sort((a,b) => b.score-a.score);
      const selected = new Map<string,StatementSeekCandidate>();
      let visitedRows = 0;
      for (const channel of channels) {
        if (after && channel.score > after.score) continue;
        if (selected.size >= STATEMENT_SEEK_COST.candidates
          && channel.score < [...selected.values()].sort(compare)[STATEMENT_SEEK_COST.candidates-1]!.score) break;
        let start = after && channel.score === after.score ? after : null;
        let found = 0;
        for (;;) {
          const rows = await client.query<Row>(`SELECT subject,predicate,meaning_key,statement_id,frame_refs
            FROM access.statement_seek WHERE data_epoch=$1 AND subject=$2 AND frame_key=$3
            ${start ? 'AND (predicate,meaning_key,statement_id)>($4,$5,$6)' : ''}
            ORDER BY predicate,meaning_key,statement_id LIMIT ${STATEMENT_SEEK_COST.candidates}`,
          [position.dataEpoch,subject,channel.key,...start ? [start.predicate,start.meaningKey,start.statementId] : []]);
          visitedRows += rows.rows.length;
          if (visitedRows > STATEMENT_SEEK_COST.visitedRows) throw new WorkReadUnavailable('Statement seek exceeds its visited-row bound');
          for (const row of rows.rows) {
            if (row.subject !== subject || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(row.statement_id)
              || !/^urn:rezics:meaning:[0-9a-f]{64}$/u.test(row.meaning_key)
              || !/^(https?:\/\/|urn:)/u.test(row.predicate) || !Array.isArray(row.frame_refs)
              || row.frame_refs.length > 8 || row.frame_refs.some(ref => typeof ref.slot !== 'string' || typeof ref.iri !== 'string'))
              throw new WorkReadUnavailable('Statement seek reference is invalid');
            const candidate = {predicate: row.predicate,meaningKey: row.meaning_key,statementId: row.statement_id,score: channel.score};
            start = candidate;
            // An OR alternative may put a Statement in several channels. Emit
            // it only in its highest specificity channel, then deduplicate ties.
            const score = frame ? [...new Set(row.frame_refs.map(ref => ref.slot))].reduce((score,slot) =>
              score+16+(row.frame_refs.some(ref => ref.slot === slot && ref.iri === frame.slots.get(slot)?.exact) ? 1 : 0),0) : 0;
            if (score !== channel.score || after && compare(candidate,after) <= 0) continue;
            selected.set(candidate.statementId,candidate);
            found++;
          }
          if (rows.rows.length < STATEMENT_SEEK_COST.candidates || found >= STATEMENT_SEEK_COST.candidates) break;
        }
      }
      await client.query('COMMIT');
      return {candidates: [...selected.values()].sort(compare).slice(0,STATEMENT_SEEK_COST.candidates),visitedRows};
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  private async replace(client: PoolClient,ref: StatementSeekReference,epoch: string) {
    await lockAccessKey(client,`statement-publication:${JSON.stringify([epoch,ref.subject])}`);
    // Recreate frame postings, but retain the local helper's publication attrs
    // on the exact live '*' tuple. Clearing must not be undone by raw replay.
    await client.query(`DELETE FROM access.statement_seek WHERE data_epoch=$1 AND statement_id=$2
      AND (frame_key<>'*' OR subject<>$3 OR predicate<>$4 OR meaning_key<>$5)`,
    [epoch,ref.statementId,ref.subject,ref.predicate,ref.meaningKey]);
    const keys = ['*',...statementFrameKeys(ref.applicability)];
    await client.query(`INSERT INTO access.statement_seek
      AS existing
      (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,statement_head)
      SELECT $1,$2,$3,$4,$5,key,$7::jsonb,$8 FROM unnest($6::text[]) key
      ON CONFLICT (data_epoch,subject,frame_key,predicate,meaning_key,statement_id) DO UPDATE
        SET frame_refs=excluded.frame_refs,statement_head=CASE
          WHEN existing.publication_source IS NOT NULL OR existing.publication_evidence
          THEN existing.statement_head ELSE excluded.statement_head END`,
    [epoch,ref.subject,ref.predicate,ref.meaningKey,ref.statementId,keys,
      JSON.stringify(ref.applicability ?? []),ref.head]);
  }
  private async readReferences(ids: readonly string[]): Promise<StatementSeekReference[]> {
    if (!ids.length) return [];
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?statement ?subject ?predicate ?key ?head ?app ?type WHERE {
        VALUES ?statement { ${ids.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rv:statementState rv:Active .
          OPTIONAL { ?statement rdf:subject ?subject }
          OPTIONAL { ?statement rdf:predicate ?predicate }
          OPTIONAL { ?statement rv:meaningKey ?key }
          OPTIONAL { ?statement rv:head ?head } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:applicability ?app }
          OPTIONAL { { GRAPH ${iri(GRAPHS.current)} { ?app a ?type } }
            UNION { GRAPH ${iri(GRAPHS.revisions)} { ?app a rv:FixedRelease } BIND(rv:FixedRelease AS ?type) } } }
      }`,STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
    const refs = new Map<string,StatementSeekReference>();
    for (const id of ids) {
      const own = rows.filter(row => row.statement?.value === id);
      if (!own.length) continue;
      if (['subject','predicate','key','head'].some(key => new Set(own.map(row => row[key]?.value)).size !== 1)
        || own.some(row => !row.subject || !row.predicate || !row.key || !row.head)) throw new WorkReadUnavailable('Statement index source is ambiguous');
      const apps = [...new Set(own.flatMap(row => row.app?.value ?? []))];
      const applicability: NonNullable<StatementSeekReference['applicability']> = [];
      if (apps.length > 8) throw new WorkReadUnavailable('Statement applicability exceeds its reference bound');
      for (const app of apps) {
        const dimension = dimensionOfTypes(own.filter(row => row.app?.value === app).flatMap(row => row.type?.value ?? []));
        applicability.push({slot: dimension ? slotOf(dimension) : 'unknown',iri: app});
      }
      refs.set(id,{statementId: id,subject: own[0]!.subject!.value,predicate: own[0]!.predicate!.value,
        meaningKey: own[0]!.key!.value,head: own[0]!.head!.value,applicability});
    }
    return [...refs.values()];
  }
  private async position(held = false) {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ; rv:sequence ?sequence . }
      ${held ? '' : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`}
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.sequence) throw new WorkReadUnavailable('Statement index source position is unavailable');
    return rows[0].sequence.value;
  }
  /** Only explicit preparation enumerates existing Statements. A populated
   * epoch has no coverage until this fenced rebuild completes. */
  async rebuild() {
    const position = await this.position(true),epoch = this.env.lineage.dataEpoch;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Explicit full raw rebuild: exclude helper writers before snapshot/delete,
      // preserving the existing recovery basis rather than inventing a marker.
      await client.query('SELECT generation FROM access.recovery_fence WHERE id=true FOR UPDATE');
      await client.query(`CREATE TEMPORARY TABLE statement_publication_rebuild_attrs ON COMMIT DROP AS
        SELECT data_epoch,subject,predicate,meaning_key,statement_id,statement_head,publication_source,publication_evidence
        FROM access.statement_seek WHERE data_epoch=$1 AND frame_key='*' AND statement_head IS NOT NULL
          AND (publication_source IS NOT NULL OR publication_evidence)`,[epoch]);
      await client.query(`INSERT INTO access.statement_seek_coverage VALUES ($1,0,false)
        ON CONFLICT (data_epoch) DO UPDATE SET complete=false`,[epoch]);
      await client.query('DELETE FROM access.statement_seek WHERE data_epoch=$1',[epoch]);
      let after = '';
      for (;;) {
        const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
          SELECT ?statement WHERE { GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rv:statementState rv:Active }
          FILTER(STR(?statement)>${lit(after)}) } ORDER BY STR(?statement) LIMIT ${STATEMENT_SEEK_COST.rebuildBatch}`,
        STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
        for (const ref of await this.readReferences(rows.map(row => row.statement!.value))) await this.replace(client,ref,epoch);
        if (rows.length < STATEMENT_SEEK_COST.rebuildBatch) break;
        after = rows.at(-1)!.statement!.value;
      }
      // Only actually active rebuilt '*' tuples with the same exact current head
      // regain helper attrs; retired/stale refs never return to raw inventory.
      await client.query(`UPDATE access.statement_seek current SET
        publication_source=old.publication_source,publication_evidence=old.publication_evidence
        FROM statement_publication_rebuild_attrs old WHERE current.data_epoch=old.data_epoch
          AND current.subject=old.subject AND current.frame_key='*' AND current.predicate=old.predicate
          AND current.meaning_key=old.meaning_key AND current.statement_id=old.statement_id
          AND current.statement_head=old.statement_head`);
      if (await this.position(true) !== position) throw new WorkReadUnavailable('Statement index rebuild position moved');
      await client.query('UPDATE access.statement_seek_coverage SET complete=true,through_sequence=$2 WHERE data_epoch=$1',[epoch,position]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  /** Replay bounded contiguous graph batches, including unrelated commands.
   * Coverage and references advance together; missing batches never become absence. */
  async projectOnce(): Promise<boolean> {
    const position = await this.position(),epoch = this.env.lineage.dataEpoch;
    // A model/bootstrap command may already have advanced an empty dataset.
    // Prove an empty active inventory; never enumerate populated startup data.
    if (!await this.coverage()) {
      const populated = await this.env.fuseki.query(`PREFIX rv: <${RV}>
        ASK { GRAPH ${iri(GRAPHS.current)} { ?statement a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ; rv:statementState rv:Active } }`);
      if (!populated.boolean) {
        if (await this.position() !== position) throw new WorkReadUnavailable('Empty Statement source position moved');
        await this.pool.query(`INSERT INTO access.statement_seek_coverage VALUES ($1,$2,true)
          ON CONFLICT DO NOTHING`,[epoch,position]);
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT generation FROM access.recovery_fence WHERE id=true FOR SHARE');
      const coverage = await client.query<{through_sequence: string; complete: boolean}>(
        'SELECT through_sequence::text,complete FROM access.statement_seek_coverage WHERE data_epoch=$1 FOR NO KEY UPDATE',[epoch]);
      const prior = coverage.rows[0];
      if (!prior?.complete || BigInt(prior.through_sequence) >= BigInt(position)) { await client.query('COMMIT'); return false; }
      const through = BigInt(position) < BigInt(prior.through_sequence)+BigInt(STATEMENT_SEEK_COST.projectionSequences)
        ? BigInt(position) : BigInt(prior.through_sequence)+BigInt(STATEMENT_SEEK_COST.projectionSequences);
      const sequences = Array.from({length: Number(through-BigInt(prior.through_sequence))},(_,i) => BigInt(prior.through_sequence)+BigInt(i+1));
      const batches = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence ?batch WHERE {
        VALUES ?sequence { ${sequences.join(' ')} } GRAPH ${iri(GRAPHS.outbox)} {
          ?batch a rv:OutboxBatch ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ?sequence } }`,STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
      if (batches.length !== sequences.length || new Set(batches.map(row => row.sequence?.value)).size !== sequences.length)
        throw new WorkReadUnavailable('Statement index outbox coverage is incomplete');
      const changed = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?statement WHERE {
        VALUES ?sequence { ${sequences.join(' ')} } GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:StatementRevision ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ?sequence ; rv:component ?statement }
      }`,STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
      const ids = changed.map(row => row.statement!.value);
      if (ids.length > STATEMENT_SEEK_COST.projectionReferences)
        throw new WorkReadUnavailable('Statement projection exceeds its reference bound');
      for (let offset=0;offset<ids.length;offset+=STATEMENT_SEEK_COST.rebuildBatch) {
        const page = ids.slice(offset,offset+STATEMENT_SEEK_COST.rebuildBatch);
        const references = await this.readReferences(page);
        // The source withdrawal head fences omission; only actually retired IDs
        // are removed wholesale. Live tuples preserve publication attrs in replace.
        await client.query(`DELETE FROM access.statement_seek WHERE data_epoch=$1
          AND statement_id=ANY($2::text[]) AND NOT (statement_id=ANY($3::text[]))`,
        [epoch,page,references.map(ref => ref.statementId)]);
        for (const ref of references) await this.replace(client,ref,epoch);
      }
      // Applicability types belong to their coordinate owner. A semantic edit
      // can move a coordinate between slots without revising the Statement.
      const coordinates = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?coordinate WHERE {
        VALUES ?sequence { ${sequences.join(' ')} } GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:SemanticRevision ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ?sequence ; rv:component ?coordinate }
      }`,STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
      if (coordinates.length > STATEMENT_SEEK_COST.projectionReferences)
        throw new WorkReadUnavailable('Coordinate projection exceeds its reference bound');
      if (coordinates.length) {
        let after = '';
        let references = ids.length;
        for (;;) {
          const page = await client.query<{statement_id: string}>(`SELECT statement_id FROM access.statement_seek
            WHERE data_epoch=$1 AND frame_key='*' AND statement_id>$2 AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(frame_refs) ref WHERE ref->>'iri'=ANY($3::text[]))
            ORDER BY statement_id LIMIT ${STATEMENT_SEEK_COST.rebuildBatch}`,
          [epoch,after,coordinates.map(row => row.coordinate!.value)]);
          references += page.rows.length;
          if (references > STATEMENT_SEEK_COST.projectionReferences)
            throw new WorkReadUnavailable('Coordinate projection exceeds its Statement reference bound');
          for (const ref of await this.readReferences(page.rows.map(row => row.statement_id))) await this.replace(client,ref,epoch);
          if (page.rows.length < STATEMENT_SEEK_COST.rebuildBatch) break;
          after = page.rows.at(-1)!.statement_id;
        }
      }
      if (await this.position() !== position) throw new WorkReadUnavailable('Statement index source moved');
      await client.query('UPDATE access.statement_seek_coverage SET through_sequence=$2 WHERE data_epoch=$1',[epoch,through.toString()]);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

export class StatementSeekWorker {
  private running = false;
  private task: Promise<void> | undefined;
  constructor(private readonly seek: StatementSeek) {}
  start() { this.running = true; this.task ??= runMainRelay(() => this.seek.projectWithPublication(),() => this.running,1000,
    {consumer: 'statement-seek'}).finally(() => {this.task = undefined;}); }
  async stop() {this.running = false; await this.task;}
}
