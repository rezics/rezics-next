import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri, lit, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { replySlotIri } from '../src/modules/realm-reply/graph.ts';
import { bestKey } from '../src/modules/feed/ranking.ts';

export interface ScaledThread {
  reply: string;
  placement: string;
  at: string;
  score: number;
}
export function placementAt(at: number, index: number) {
  const hex = at.toString(16).padStart(12, '0');
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${index.toString(16).padStart(12, '0')}`;
}

/** A deterministic owner snapshot cloned from one API-created, approved thread.
 * Every filler has real Content identity/revision/review/pin and a current graph
 * placement; no disabled constraints, fake request transport or inserted cache.
 * Preparation is diagnostic owner import, not a throughput claim for commands. */
export async function growRealmThreads(
  content: Pool,
  access: Pool,
  env: WorkActivationEnvironment,
  realm: string,
  source: string,
  first: number,
  count: number,
  parent?: { reply: string; chain: boolean },
): Promise<ScaledThread[]> {
  const now = Date.now();
  const replies = Array.from({ length: count }, () => `https://rezics.com/id/${randomUUID()}`);
  const entries = Array.from({ length: count }, (_, offset) => {
    const index = first + offset;
    const age = index === 0 ? 2 * 86_400_000 : index % 20 === 0
      ? (30 + index % 366) * 86_400_000 : (1 + index % 60) * 60_000;
    const at = new Date(now - age - 60_000).toISOString();
    return {
      reply: replies[offset]!,
      parent: parent ? parent.chain && offset > 0 ? replies[offset - 1]! : parent.reply : null,
      variant: `urn:rezics:variant:${randomUUID()}`,
      revision: randomUUID(),
      review: randomUUID(),
      placement: placementAt(Date.parse(at), index + 1),
      operation: `g1034:${randomUUID()}`,
      at,
      score: index === 0 ? 2_000_000_000 : (index % 17) - 8,
    };
  });
  const client = await content.connect();
  let sourceRow: { author: string; root_target: string; root_revision: string };
  try {
    await client.query('BEGIN');
    const owner = (
      await client.query<{ sequence: string; data_epoch: string }>(`SELECT sequence::text,data_epoch
      FROM content.owner_control WHERE singleton FOR UPDATE`)
    ).rows[0]!;
    sourceRow = (
      await client.query<{ author: string; root_target: string; root_revision: string }>(
        'SELECT author,root_target,root_revision FROM content.reply WHERE id=$1',
        [source],
      )
    ).rows[0]!;
    await client.query(
      `CREATE TEMP TABLE g1034_rows ON COMMIT DROP AS SELECT x.*,row_number() OVER () AS ordinal
      FROM jsonb_to_recordset($1::jsonb) AS x(reply text,variant text,revision uuid,
        review uuid,placement text,operation text,at timestamptz,score int,parent text)`,
      [JSON.stringify(entries)],
    );
    // jsonb_populate_record preserves schema additions and the source's owner
    // evidence. Only identities and operation/revision pointers are translated.
    await client.query(
      `INSERT INTO content.variant SELECT (jsonb_populate_record(NULL::content.variant,
      to_jsonb(v)||jsonb_build_object('id',x.variant,'resource_id',x.reply,'draft_head',NULL))).*
      FROM g1034_rows x CROSS JOIN content.reply p JOIN content.variant v ON v.id=p.variant_id WHERE p.id=$1`,
      [source],
    );
    await client.query(
      `INSERT INTO content.revision SELECT (jsonb_populate_record(NULL::content.revision,
      to_jsonb(r)||jsonb_build_object('id',x.revision,'variant_id',x.variant,'operation_id',x.operation||':draft.save',
        'predecessor',NULL))).* FROM g1034_rows x CROSS JOIN content.reply p JOIN content.variant v ON v.id=p.variant_id
      JOIN content.revision r ON r.id=v.draft_head WHERE p.id=$1`,
      [source],
    );
    await client.query(
      'UPDATE content.variant v SET draft_head=x.revision FROM g1034_rows x WHERE v.id=x.variant',
    );
    await client.query(
      `INSERT INTO content.receipt SELECT (jsonb_populate_record(NULL::content.receipt,
      to_jsonb(r)||jsonb_build_object('operation_id',x.operation||':'||a.action,'action',a.action,
        'variant_id',x.variant,'revision_id',x.revision,'data_epoch',$2::text,
        'sequence',$3::bigint+(x.ordinal-1)*4+a.ordinal_offset+1))).*
      FROM g1034_rows x CROSS JOIN (VALUES (0,'draft.save'),(1,'reply.create'),(2,'review.decide'),(3,'publication.prepare')) a(ordinal_offset,action)
      CROSS JOIN content.reply p JOIN content.receipt r ON r.operation_id=p.operation_id WHERE p.id=$1`,
      [source, owner.data_epoch, owner.sequence],
    );
    await client.query(
      `INSERT INTO content.reply_author SELECT (jsonb_populate_record(NULL::content.reply_author,
      to_jsonb(a)||jsonb_build_object('reply',x.reply,'variant_id',x.variant,'operation_id',x.operation||':draft.save'))).*
      FROM g1034_rows x CROSS JOIN content.reply_author a WHERE a.reply=$1`,
      [source],
    );
    await client.query(
      `INSERT INTO content.reply SELECT (jsonb_populate_record(NULL::content.reply,
      to_jsonb(p)||jsonb_build_object('id',x.reply,'variant_id',x.variant,'operation_id',x.operation||':reply.create',
        'created_at',x.at,'parent_reply',x.parent,'parent_variant',above.variant,'parent_revision',above.revision))).*
      FROM g1034_rows x CROSS JOIN content.reply p LEFT JOIN LATERAL (
        SELECT v.id AS variant,v.draft_head AS revision FROM content.reply r
          JOIN content.variant v ON v.id=r.variant_id WHERE r.id=x.parent
        UNION ALL SELECT r.variant,r.revision FROM g1034_rows r WHERE r.reply=x.parent
      ) above ON true WHERE p.id=$1`,
      [source],
    );
    await client.query(
      `INSERT INTO content.realm_review_decision SELECT (jsonb_populate_record(NULL::content.realm_review_decision,
      to_jsonb(d)||jsonb_build_object('id',x.review,'variant_id',x.variant,'revision_id',x.revision,
        'operation_id',x.operation||':review.decide'))).* FROM g1034_rows x CROSS JOIN content.reply p
      JOIN content.realm_review_decision d ON d.variant_id=p.variant_id WHERE p.id=$1 AND d.realm=$2 AND d.review_generation=1`,
      [source, realm],
    );
    await client.query(
      `INSERT INTO content.publication_preparation SELECT (jsonb_populate_record(NULL::content.publication_preparation,
      to_jsonb(p)||jsonb_build_object('operation_id',x.operation||':publication.prepare','revision_id',x.revision,
        'status','pending','graph_receipt',NULL,'graph_data_epoch',NULL,'graph_sequence',NULL,
        'terminal_proof_digest',NULL,'settled_at',NULL))).* FROM g1034_rows x CROSS JOIN content.reply r
      JOIN content.realm_placement_preparation rp ON rp.variant_id=r.variant_id
      JOIN content.publication_preparation p ON p.operation_id=rp.operation_id WHERE r.id=$1 AND rp.realm=$2`,
      [source, realm],
    );
    await client.query(
      `INSERT INTO content.realm_placement_preparation SELECT (jsonb_populate_record(NULL::content.realm_placement_preparation,
      to_jsonb(p)||jsonb_build_object('operation_id',x.operation||':publication.prepare','variant_id',x.variant,
        'revision_id',x.revision,'review_decision_id',x.review))).* FROM g1034_rows x CROSS JOIN content.reply r
      JOIN content.realm_placement_preparation p ON p.variant_id=r.variant_id WHERE r.id=$1 AND p.realm=$2`,
      [source, realm],
    );
    await client.query(
      `UPDATE content.publication_preparation p SET status='active',graph_receipt='urn:rezics:g1034:fixture',
      graph_data_epoch=$1,graph_sequence='1',terminal_proof_digest=repeat('a',64),settled_at=now()
      FROM g1034_rows x WHERE p.operation_id=x.operation||':publication.prepare'`,
      [env.lineage.dataEpoch],
    );
    await client.query(`INSERT INTO content.outbox(id,data_epoch,sequence,operation_id,event_type,recipe,revision_id,payload)
      SELECT gen_random_uuid(),r.data_epoch,r.sequence,r.operation_id,'content.fixture.imported','realm-reply-v1',r.revision_id,'{}'
      FROM g1034_rows x JOIN content.receipt r ON r.variant_id=x.variant`);
    await client.query('UPDATE content.owner_control SET sequence=sequence+$1 WHERE singleton', [
      entries.length * 4,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (let offset = 0; offset < entries.length; offset += 200) {
    const batch = entries.slice(offset, offset + 200);
    await env.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${batch
        .map(
          (row) => `${iri(replySlotIri(realm, row.reply))} a rv:RealmReplySlot ;
        rv:realm ${iri(realm)} ; rv:reply ${iri(row.reply)} ; rv:rootTarget ${iri(sourceRow!.root_target)} ;
        rv:replyPlacementHead ${iri(row.placement)} .`,
        )
        .join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${batch
        .map(
          (row) => `${iri(row.placement)} a rv:RealmReplyPlacement ;
        rv:component ${iri(replySlotIri(realm, row.reply))} ; rv:realm ${iri(realm)} ; rv:reply ${iri(row.reply)} ;
        rv:rootTarget ${iri(sourceRow!.root_target)} ; rv:rootRevision ${lit(sourceRow!.root_revision)} ;
        rv:author ${iri(sourceRow!.author)} ; rv:contentRevision ${iri(`urn:rezics:content:revision:${row.revision}`)} ;
        ${row.parent ? `rv:parentReply ${iri(row.parent)} ;` : ''}
        rv:reviewDecision ${iri(`urn:rezics:realm-review:${row.review}`)} ; rv:contentPreparation ${lit(`${row.operation}:publication.prepare`)} ;
        rv:placementOutcome rv:Accepted ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 1 .`,
        )
        .join('\n')} } }`);
  }
  await access.query(
    `INSERT INTO access.feed_item(data_epoch,id,sequence,kind,occurred_at,time_basis,score,best_key,
    realm,group_bucket,group_key,group_leader,group_members,sort_time,target_indexed,realm_thread_indexed,work)
    SELECT $1,x.placement,1,'discussion',x.at,'revision',x.score,x.key,$2,x.placement,x.placement,true,
      ARRAY[x.placement],x.at,true,true,$4 FROM jsonb_to_recordset($3::jsonb) AS x(placement text,at timestamptz,score int,key float8)`,
    [
      env.lineage.dataEpoch,
      realm,
      JSON.stringify(
        entries.map((row) => ({ ...row, key: bestKey(row.score, Date.parse(row.at)) })),
      ),
      sourceRow!.root_target,
    ],
  );
  await access.query(
    `INSERT INTO access.realm_thread_reference(data_epoch,realm,reply,placement,parent,thread,work,
    occurred_at,activity_at,active,score) SELECT $1,$2,x.reply,x.placement,NULL,x.reply,$4,x.at,x.at,true,x.score
    FROM jsonb_to_recordset($3::jsonb) AS x(reply text,placement text,at timestamptz,score int)`,
    [env.lineage.dataEpoch, realm, JSON.stringify(entries), sourceRow!.root_target],
  );
  const owner = (
    await content.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch,sequence::text FROM content.owner_control WHERE singleton',
    )
  ).rows[0]!;
  await access.query(
    `UPDATE access.realm_thread_checkpoint SET content_epoch=$2,content_sequence=$3 WHERE data_epoch=$1`,
    [env.lineage.dataEpoch, owner.data_epoch, owner.sequence],
  );
  return entries;
}
