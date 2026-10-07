import type { Pool, PoolClient } from 'pg';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { dimensionOfTypes, slotOf, type Coordinate } from '../projection/dimension.ts';
import { runMainRelay } from '../outbox/worker.ts';

export const STATEMENT_SEEK_COST = { candidates: 20, frameChannels: 256, visitedRows: 4096,
  projectionSequences: 64, rebuildBatch: 128, projectionReferences: 8192, responseBytes: 1024 * 1024 } as const;
export interface StatementSeekReference { subject: string; predicate: string; meaningKey: string;
  statementId: string; applicability: { slot: string; iri: string }[] | null }
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
  constructor(private readonly pool: Pool,private readonly env: WorkActivationEnvironment) {}
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
    await client.query('DELETE FROM access.statement_seek WHERE data_epoch=$1 AND statement_id=$2',[epoch,ref.statementId]);
    const keys = ['*',...statementFrameKeys(ref.applicability)];
    await client.query(`INSERT INTO access.statement_seek
      (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs)
      SELECT $1,$2,$3,$4,$5,key,$7::jsonb FROM unnest($6::text[]) key`,
    [epoch,ref.subject,ref.predicate,ref.meaningKey,ref.statementId,keys,JSON.stringify(ref.applicability ?? [])]);
  }
  private async readReferences(ids: readonly string[]): Promise<StatementSeekReference[]> {
    if (!ids.length) return [];
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?statement ?subject ?predicate ?key ?app ?type WHERE {
        VALUES ?statement { ${ids.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rv:statementState rv:Active .
          OPTIONAL { ?statement rdf:subject ?subject }
          OPTIONAL { ?statement rdf:predicate ?predicate }
          OPTIONAL { ?statement rv:meaningKey ?key } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:applicability ?app }
          OPTIONAL { { GRAPH ${iri(GRAPHS.current)} { ?app a ?type } }
            UNION { GRAPH ${iri(GRAPHS.revisions)} { ?app a rv:FixedRelease } BIND(rv:FixedRelease AS ?type) } } }
      }`,STATEMENT_SEEK_COST.responseBytes)).results?.bindings ?? [];
    const refs = new Map<string,StatementSeekReference>();
    for (const id of ids) {
      const own = rows.filter(row => row.statement?.value === id);
      if (!own.length) continue;
      if (['subject','predicate','key'].some(key => new Set(own.map(row => row[key]?.value)).size !== 1)
        || own.some(row => !row.subject || !row.predicate || !row.key)) throw new WorkReadUnavailable('Statement index source is ambiguous');
      const apps = [...new Set(own.flatMap(row => row.app?.value ?? []))];
      const applicability: NonNullable<StatementSeekReference['applicability']> = [];
      if (apps.length > 8) throw new WorkReadUnavailable('Statement applicability exceeds its reference bound');
      for (const app of apps) {
        const dimension = dimensionOfTypes(own.filter(row => row.app?.value === app).flatMap(row => row.type?.value ?? []));
        applicability.push({slot: dimension ? slotOf(dimension) : 'unknown',iri: app});
      }
      refs.set(id,{statementId: id,subject: own[0]!.subject!.value,predicate: own[0]!.predicate!.value,
        meaningKey: own[0]!.key!.value,applicability});
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
      const coverage = await client.query<{through_sequence: string; complete: boolean}>(
        'SELECT through_sequence::text,complete FROM access.statement_seek_coverage WHERE data_epoch=$1 FOR UPDATE',[epoch]);
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
        await client.query('DELETE FROM access.statement_seek WHERE data_epoch=$1 AND statement_id=ANY($2::text[])',[epoch,page]);
        for (const ref of await this.readReferences(page)) await this.replace(client,ref,epoch);
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
  start() { this.running = true; this.task ??= runMainRelay(() => this.seek.projectOnce(),() => this.running,1000,
    {consumer: 'statement-seek'}).finally(() => {this.task = undefined;}); }
  async stop() {this.running = false; await this.task;}
}
