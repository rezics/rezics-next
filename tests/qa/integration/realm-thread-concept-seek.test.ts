import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { personaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { REALM_RANK_SEEK_SETTINGS, realmConceptRankCut, realmRankSeek, RealmThreadRankingProjection } from '../../../services/main/src/modules/rankings/realm-threads.ts';
import type { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { controlRead } from '../../../services/main/src/modules/access/topology-control.ts';
import type { FeedCheckpoint } from '../../../services/main/src/modules/feed/store.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Plan = { 'Relation Name'?: string; 'Index Cond'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; 'Shared Hit Blocks': number;
  'Shared Read Blocks': number; Plans?: Plan[] };
const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
const uri = (value: string) => ({ type: 'uri', value });

test('maintained Concept cuts backfill in bounded turns, seek sparse pages and retain removed-anchor keys under growth', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access'], 'owner');
  const access = new Pool({ connectionString: databases.urls.access });
  const epoch = randomUUID(), contentEpoch = randomUUID(), realm = id(100), concepts = Array.from({ length: 8 }, (_, n) => id(200+n));
  const insert = (start: number, count: number, selected: string[] | null) => access.query(`INSERT INTO access.realm_thread_reference
    (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,score,active,concepts,new_sequence)
    SELECT $1,$2,'https://rezics.com/id/00000000-0000-4000-8000-'||lpad(n::text,12,'0'),
      'https://rezics.com/id/00000000-0000-4000-8000-'||lpad((n+100000)::text,12,'0'),NULL,
      'https://rezics.com/id/00000000-0000-4000-8000-'||lpad(n::text,12,'0'),$3,
      now()+n*interval '1 millisecond',now(),CASE n WHEN 1 THEN 3 WHEN 2 THEN 10 ELSE -5 END,true,$4,n
      FROM generate_series($5::integer,$5::integer+$6::integer-1) n`, [epoch,realm,id(101),selected,start,count]);
  const read = (sql: string, args: unknown[]) => controlRead(access, async client => {
    await client.query(REALM_RANK_SEEK_SETTINGS); return client.query(sql,args);
  });
  const values = (concept = concepts[0], after?: { rank_key: number; time_key: string; placement: string }) =>
    [epoch,realm,'all',after?.rank_key ?? null,after?.time_key ?? null,after?.placement ?? '',2,contentEpoch,'0','0',null,concept];
  try {
    await access.query('UPDATE access.recovery_fence SET open=true WHERE id');
    await access.query("INSERT INTO access.realm_thread_checkpoint VALUES($1,0,'￿',$2,0)", [epoch,contentEpoch]);
    await insert(1,21,null); // The migration's NULL checkpoint represents retained placements.
    const pending = await read(realmConceptRankCut('new',false),values());
    expect(pending.rows[0].complete).toBe(false);
    const session = { position: { dataEpoch: epoch, sequence: '0' }, restorePriors: new Map(),
      query: async (sql: string) => Array.from({ length: 21 }, (_, n) => n+1).filter(n => sql.includes(`<${id(n)}>`)).map(n => ({
        realm: uri(realm), reply: uri(id(n)), id: uri(id(n+100000)), work: uri(id(101)), author: uri(id(102)),
        rootRevision: uri(id(103)), revision: uri('urn:rezics:content:revision:'+randomUUID()),
        review: uri('urn:rezics:realm-review:'+randomUUID()), preparation: uri('prepared'), epochOrder: uri('0'), sequence: uri(String(n)),
      })), deps: { content: {}, environment: { fuseki: { query: async () => ({ results: { bindings: concepts.map(concept => ({ concept: uri(concept) })) } }) } },
        realmReplyThreads: { rankingContent: { query: async () => ({ rows: [{ data_epoch: contentEpoch, sequence: '0' }] }) },
          admitted: async (_realm: string, heads: { reply: string }[]) => new Map(heads.map(head => [head.reply,
            { rootTarget: id(101), rootRevision: id(103), author: id(102), parent: null }])) } } } as unknown as WorkReadSession;
    await new RealmThreadRankingProjection(access,access).tick(session,{ data_epoch: epoch } as FeedCheckpoint,'0');
    expect((await access.query('SELECT count(*)::integer AS n FROM access.realm_thread_reference WHERE data_epoch=$1 AND concepts IS NULL',[epoch])).rows[0].n).toBe(1);
    await new RealmThreadRankingProjection(access,access).tick(session,{ data_epoch: epoch } as FeedCheckpoint,'0');
    expect((await access.query('SELECT count(*)::integer AS n FROM access.realm_thread_order WHERE data_epoch=$1 AND reply=$2',[epoch,id(1)])).rows[0].n).toBe(45);
    await access.query('DELETE FROM access.realm_thread_reference WHERE data_epoch=$1 AND reply<>ALL($2::text[])',[epoch,[id(1),id(2),id(3)]]);
    await access.query('UPDATE access.realm_thread_reference SET score=CASE reply WHEN $2 THEN 3 WHEN $3 THEN 10 ELSE -5 END WHERE data_epoch=$1',[epoch,id(1),id(2)]);
    const work: number[] = [];
    for (const growth of [0,100,2000]) {
      if (growth) await insert(1000+growth,growth,[]);
      for (const sort of ['new','best','top'] as const) {
        const sql = realmConceptRankCut(sort,false), args = values();
        const page = (await read(sql,args)).rows[0];
        expect(page.complete).toBe(true);
        expect(page.rows.map((r: { reply: string }) => r.reply)).toEqual(sort==='new' ? [id(3),id(2)] : [id(2),id(1)]);
        const plan: Plan = (await read(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${sql}`,args)).rows[0]['QUERY PLAN'][0].Plan;
        const scans = nodes(plan).filter(n => n['Relation Name']==='realm_thread_order');
        expect(scans.some(n => n['Index Cond']?.includes('concept'))).toBe(true);
        const examined = scans.reduce((sum,n) => sum+(n['Actual Rows']+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*n['Actual Loops'],0);
        expect(examined).toBeLessThanOrEqual(2); work.push(examined);
        const empty = (await read(sql,values(id(999)))).rows[0];
        expect(empty.rows).toEqual([]); expect(empty.complete).toBe(true);
      }
    }
    expect(new Set(work).size).toBe(1);
    for (const sort of ['new','best','top'] as const) {
      const full = values(); full[6]=3;
      const before = (await read(realmRankSeek(sort,false,false,true),full)).rows;
      await access.query('UPDATE access.realm_thread_reference SET active=false WHERE data_epoch=$1 AND reply=$2',[epoch,before[0].reply]);
      const after = (await read(realmRankSeek(sort,true,false,true),values(concepts[0],before[0]))).rows;
      expect(after.map(r => r.reply)).toEqual(before.slice(1).map(r => r.reply));
      await access.query('UPDATE access.realm_thread_reference SET active=true WHERE data_epoch=$1 AND reply=$2',[epoch,before[0].reply]);
    }
  } finally { await access.end(); await databases.close(); }
},120_000);

async function answer<T>(request: Promise<Response>, status = 201): Promise<T> {
  const response = await request, raw = await response.text(); expect(response.status,raw).toBe(status); return JSON.parse(raw) as T;
}
test('HTTP sparse Concept pages and empty boards preserve exact New/Best/Top continuations and cursor scope', async () => {
  const sessions = await personaSessions('public'), { owner,visitor,stranger } = sessions;
  const short = (iri: string) => iri.slice(-36);
  try {
    await grantPersonaFixtureAuthority(owner,[{ scope: 'classification:define:global', action: 'classification.proposition.define' }]);
    const concepts: { concept: string; scheme: string; schemeHead: string }[] = [];
    for (let n=0;n<9;n++) concepts.push(await answer(owner.main('POST','/v1/classification-vocabulary',{
      profile:'classification-proposition-v2',scheme:n ? { id:concepts[n-1]!.scheme,expectedHead:concepts[n-1]!.schemeHead } : null,
      labels:[{ language:'en',value:`Seek board ${n} ${randomUUID()}` }],alternativeLabels:[],broader:[],narrower:[],actingSubject:owner.actingSubject,
    })));
    const work = await answer<{ work: string; workRevision: string; mainVersion: string }>(owner.main('POST','/v1/works',{
      profile:'metadata-only-v1',title:'Concept seek discussions',language:'en',authoring:'own-work',actingSubject:owner.actingSubject,
    }));
    const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST','/v1/contributions',{
      profile:'text-contribution-v1',work:work.work,language:'en',body:'An original garden story.',actingSubject:owner.actingSubject,
    }));
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST','/v1/contribution-publications',{
      profile:'text-publication-v1',contribution:draft.contribution,expectedDraftHead:draft.draftRevision,expectedPublicationHead:null,
      rightsBasis:'original-contribution',disclosure:'public',actingSubject:owner.actingSubject,
    }));
    await answer(owner.main('POST','/v1/publication-selections',{ profile:'main-default-selection-v1',work:work.work,contribution:draft.contribution,
      publicationDecision:publication.publicationDecision,expectedSelectionHead:null,context:{ kind:'main-version-default',id:work.mainVersion },
      selectionBasis:'main-maintainer',actingSubject:owner.actingSubject }));
    const placed: { input: Record<string,unknown>; placement: string; reply: string; key: string }[] = [];
    for (let n=0;n<5;n++) {
      await answer(owner.main('GET',`/v1/works/${short(work.work)}?actingSubject=${owner.actingSubject}`),200);
      const reply = await answer<{ reply: string; variantId: string; revisionId: string; revisionDigest: string }>(owner.main('POST','/v1/member-reply-drafts',{
        profile:'member-reply-draft-v1',reply:`https://rezics.com/id/${randomUUID()}`,variantId:`urn:rezics:variant:${randomUUID()}`,
        rootTarget:work.work,rootRevision:work.workRevision,originRealm:sessions.realm,language:'en',direction:'ltr',expectedHead:null,
        body:`Discussion ${n}\nOriginal garden discussion.`,actingSubject:owner.actingSubject,
      }));
      await answer(owner.main('POST','/v1/realm-replies',{ profile:'realm-reply-identity-v1',reply:reply.reply,variantId:reply.variantId,revisionId:reply.revisionId,author:owner.actingSubject,
        rootTarget:work.work,rootRevision:work.workRevision,parentReply:null,parentRevision:null,contextRevision:null }));
      const input = { profile:'realm-reply-placement-v1',realm:sessions.realm,reply:reply.reply,revisionId:reply.revisionId,
        revisionDigest:reply.revisionDigest,reviewDecisionId:null,expectedHead:null,actingSubject:owner.actingSubject,
        concepts:n<2 ? concepts.slice(0,8).map(c=>c.concept) : [],primaryConcept:n<2 ? concepts[0]!.concept : null };
      const key = randomUUID();
      const saved = await answer<{ placement: string; concepts: string[]; primaryConcept: string | null }>(owner.main('POST','/v1/realm-reply-placements',input,key));
      expect(saved.concepts).toEqual([...input.concepts].sort()); expect(saved.primaryConcept).toBe(input.primaryConcept);
      placed.push({ input,key,placement:saved.placement,reply:reply.reply });
    }
    await answer(owner.main('POST','/v1/realm-reply-placements',{ ...placed[0]!.input,expectedHead:placed[0]!.placement,
      concepts:concepts.map(c=>c.concept) }),400);
    type Page = { items: { reply: string }[]; nextCursor: string | null; count: { value: number } };
    const root = `/v1/realms/${short(sessions.realm)}/threads`;
    const cursors = new Map<string,string>();
    for (const sort of ['new','best','top']) {
      const query = new URLSearchParams({ sort,window:'all',concept:concepts[0]!.concept,limit:'1' });
      const first = await answer<Page>(visitor.main('GET',`${root}?${query}`),200);
      expect(first.items.map(r=>r.reply)).toEqual([placed[1]!.reply]); expect(first.count.value).toBe(1); expect(first.nextCursor).toBeString();
      cursors.set(sort,first.nextCursor!); query.set('cursor',first.nextCursor!);
      const second = await answer<Page>(visitor.main('GET',`${root}?${query}`),200);
      expect(second.items.map(r=>r.reply)).toEqual([placed[0]!.reply]); expect(second.nextCursor).toBeNull();
      await answer(stranger.main('GET',`${root}?${query}`),400);
      const otherOrder = new URLSearchParams(query); otherOrder.set('sort',sort==='new'?'top':'new');
      await answer(visitor.main('GET',`${root}?${otherOrder}`),400);
      query.set('concept',concepts[8]!.concept); await answer(visitor.main('GET',`${root}?${query}`),400);
      query.delete('cursor'); const empty = await answer<Page>(visitor.main('GET',`${root}?${query}`),200);
      expect(empty).toMatchObject({ items:[],count:{ value:0 },nextCursor:null });
    }
    await answer(owner.main('POST','/v1/realm-reply-placements',{ ...placed[1]!.input,expectedHead:placed[1]!.placement,concepts:[],primaryConcept:null }));
    const replay = await answer<{ placement: string }>(owner.main('POST','/v1/realm-reply-placements',placed[1]!.input,placed[1]!.key));
    expect(replay.placement).toBe(placed[1]!.placement);
    for (const sort of ['new','best','top']) {
      const query = new URLSearchParams({ sort,window:'all',concept:concepts[0]!.concept,limit:'1',cursor:cursors.get(sort)! });
      await answer(visitor.main('GET',`${root}?${query}`),409); // Removal invalidates the published population explicitly.
      query.delete('cursor'); const remaining = await answer<Page>(visitor.main('GET',`${root}?${query}`),200);
      expect(remaining.items.map(r=>r.reply)).toEqual([placed[0]!.reply]); expect(remaining.nextCursor).toBeNull();
    }
  } finally { await sessions.close(); }
},180_000);
