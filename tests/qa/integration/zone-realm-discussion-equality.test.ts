import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ensureFixtureScopeGate } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { comparableBody } from '../support/hidden-id-equality.ts';
import { startHomeStack, type HomeStack } from './feed-read-support.ts';
import { attributeSqlCheckoutCallers, foregroundCounted } from './support/query-cost-meter.ts';
import { arrange, local, type Posted } from './zone-realm-discussion-support.ts';

/** A committed body-disclosure fixture, including its case, decision and target.
 * Moderation admission is proved in its own suites; this uses the real read owner. */
async function hideBody(home: HomeStack, actor: string, reply: string, revision: string) {
  const caseId = randomUUID(), decisionId = randomUUID(), fenceId = randomUUID();
  const client = await home.stack.accessPool.connect();
  try {
    await client.query('BEGIN');
    await ensureFixtureScopeGate(client, 'governance:platform');
    await client.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','content',$2,'body','private')`,
    [caseId, reply]);
    await client.query(`INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
      authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure,statement_of_reasons)
      VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform','governance:platform',
      0,$5,$1::text,$5,'urn:rezics:rule:hidden-about-post','1',$5,$5,'private',$6::jsonb)`,
    [decisionId, caseId, home.author.principalId, actor, 'a'.repeat(64), {
      facts: 'The accepted opener body is withheld from public disclosure.', scope: 'This exact reply body revision.',
      duration: 'Until an attributable restoration.', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
      rule: { ref: 'urn:rezics:rule:hidden-about-post', revision: '1', digest: 'a'.repeat(64) },
    }]);
    await client.query(`INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
      VALUES ($1,1,'content',$2,'body','exact_revision',$3,$3,'disclosure')`, [decisionId, reply, revision]);
    await client.query(`INSERT INTO access.governance_enforcement
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','content',$2,'body',$3,'disclosure',$4,1,'restricted',1)`,
    [fenceId, reply, revision, decisionId]);
    await client.query('UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1', [caseId, decisionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const ownResultKeys = ['about', 'author', 'placement', 'profile', 'realm', 'reply', 'revisionId'];
const parentPointer = 'SELECT thread,active FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3';
type SqlStatement = { sql: string; count: number };
function sqlCounts(trace: SqlStatement[], omitParent = false) {
  const counts = new Map<string, number>();
  for (const entry of trace) {
    if (omitParent && entry.sql === parentPointer) continue;
    counts.set(entry.sql, (counts.get(entry.sql) ?? 0) + entry.count);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

test('hidden and absent openers give undisclosing own-post responses with bounded owner costs; unavailable targets give equal 404s', async () => {
  // These commands do not project Feed. Leave its shared checkpoint untouched;
  // a graph cut is not a position in the acknowledged Main stream.
  // Composition captures connect and client.query in instance wrappers. Both
  // hooks must precede construction; later prototype patches miss those clients.
  const restoreCheckoutCallers = attributeSqlCheckoutCallers();
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const originalQuery = prototype.query;
  let statements = 0, measuring = false;
  let sqlTrace: SqlStatement[] = [];
  prototype.query = function (this: unknown, ...args: unknown[]) {
    if (measuring && foregroundCounted()) {
      statements++;
      const query = args[0];
      const sql = (typeof query === 'string' ? query : (query as { text?: string })?.text ?? '').replace(/\s+/g, ' ').trim();
      const entry = sqlTrace.find(item => item.sql === sql);
      if (entry) entry.count++;
      else sqlTrace.push({ sql, count: 1 });
    }
    return originalQuery.apply(this, args);
  };
  const home = await startHomeStack('zone-realm-discussion-equality').catch(error => {
    prototype.query = originalQuery;
    restoreCheckoutCallers();
    throw error;
  });
  try {
    const a = await arrange(home);
    const firstPage = await a.page('hidden-opener');
    const absentPage = await a.page('absent-opener');
    const hiddenPage = { ...firstPage, routeRevision: (await a.route(firstPage.path)).revision };
    const opener = await home.json<Posted>(await a.post(hiddenPage, a.author,
      'The original opener remains retained.', home.author.token), 201);
    const lookup = `/v1/realms/${local(a.realm.realm)}/about-thread?${new URLSearchParams({ about: hiddenPage.about })}`;
    expect(await home.json(await home.call('GET', lookup))).toMatchObject({
      thread: { reply: opener.reply, rootRevision: hiddenPage.targetRevision },
    });
    await hideBody(home, a.author, opener.reply, opener.revisionId);
    expect(await home.json(await home.call('GET', lookup))).toEqual({ realm: a.realm.realm, about: hiddenPage.about, thread: null });
    expect(await a.effects(absentPage.about)).toEqual({ threads: 0, operations: 0, replies: 0, revisions: 0 });

    // Warm only the existing principal-budget cache. Missing-key refusal makes no contribution.
    expect((await a.post(absentPage, a.reader, 'Warm principal attribution', home.reader.token, '')).status).toBe(400);
    const observe = async (request: () => Promise<Response>) => {
      expect((await a.post(absentPage, a.reader, 'Warm principal attribution', home.reader.token, '')).status).toBe(400);
      const sql = statements, graph = home.stack.fuseki.queries;
      sqlTrace = [];
      measuring = true;
      try {
        const response = await request(), text = await response.text();
        return { status: response.status, text, body: JSON.parse(text) as Posted,
          cost: { sql: statements - sql, graph: home.stack.fuseki.queries - graph }, sqlTrace };
      } finally { measuring = false; }
    };
    const text = 'My own contribution.', hiddenKey = randomUUID(), absentKey = randomUUID();
    const hidden = await observe(() => a.post(hiddenPage, a.reader, text, home.reader.token, hiddenKey));
    const absent = await observe(() => a.post(absentPage, a.reader, text, home.reader.token, absentKey));
    await Bun.write(`.temp/zone-discussion-equality-${Bun.env.REZICS_QA_RUN_ID}.json`, JSON.stringify({
      runId: Bun.env.REZICS_QA_RUN_ID, persona: 'Person contributor viewing a hidden or absent opener',
      hidden: { request: { method: 'POST', path: `/v1/realms/${local(a.realm.realm)}/about-posts`,
        idempotencyKey: hiddenKey, body: a.input(hiddenPage, a.reader, text) }, answer: hidden },
      absent: { request: { method: 'POST', path: `/v1/realms/${local(a.realm.realm)}/about-posts`,
        idempotencyKey: absentKey, body: a.input(absentPage, a.reader, text) }, answer: absent },
      withheld: { reply: opener.reply, revisionId: opener.revisionId },
    }, null, 2));
    for (const observed of [hidden, absent]) {
      expect(observed.status, observed.text).toBe(201);
      expect(Object.keys(observed.body).sort()).toEqual(ownResultKeys);
      expect(observed.body).toMatchObject({ profile: 'realm-about-post-v1', realm: a.realm.realm, author: a.reader });
      expect(observed.body.reply).not.toBe(opener.reply);
      expect(observed.text).not.toContain(opener.reply);
      expect(observed.text).not.toContain(opener.revisionId);
    }
    // Settlement resolves one indexed parent pointer for a child and none for
    // a new opener (rankings/realm-threads.ts). Every other statement must match;
    // no thread/member inventory or unrelated background work is excused.
    expect(sqlCounts(hidden.sqlTrace)[parentPointer]).toBe(1);
    expect(sqlCounts(absent.sqlTrace)[parentPointer] ?? 0).toBe(0);
    expect(sqlCounts(hidden.sqlTrace, true)).toEqual(sqlCounts(absent.sqlTrace, true));
    expect(hidden.cost).toEqual({ ...absent.cost, sql: absent.cost.sql + 1 });
    expect(hidden.cost.graph).toBeLessThanOrEqual(195);
    const hiddenReplay = await observe(() => a.post(hiddenPage, a.reader, text, home.reader.token, hiddenKey));
    const absentReplay = await observe(() => a.post(absentPage, a.reader, text, home.reader.token, absentKey));
    expect(hiddenReplay.status, hiddenReplay.text).toBe(200);
    expect(absentReplay.status, absentReplay.text).toBe(200);
    expect(hiddenReplay.body).toEqual(hidden.body);
    expect(absentReplay.body).toEqual(absent.body);
    expect(hiddenReplay.cost).toEqual(absentReplay.cost);
    expect(sqlCounts(hiddenReplay.sqlTrace)).toEqual(sqlCounts(absentReplay.sqlTrace));

    const retained = await a.rows(hiddenPage.about), opened = await a.rows(absentPage.about);
    expect(retained).toHaveLength(2);
    expect(retained.find(row => row.reply === hidden.body.reply)).toMatchObject({ author: a.reader,
      parent_reply: opener.reply, root_target: hiddenPage.about, root_revision: hiddenPage.targetRevision,
      origin_realm: a.realm.realm, body: { body: text } });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ reply: absent.body.reply, author: a.reader, parent_reply: null,
      root_target: absentPage.about, root_revision: absentPage.targetRevision, body: { body: text } });
    const canonical = await home.stack.contentPool.query<{ opener_reply: string; root_revision: string }>(
      'SELECT opener_reply,root_revision FROM content.realm_about_thread WHERE realm=$1 AND about=$2',
      [a.realm.realm, hiddenPage.about]);
    expect(canonical.rows).toEqual([{ opener_reply: opener.reply, root_revision: hiddenPage.targetRevision }]);
    const parent = await home.stack.contentPool.query<{ parent_revision: string }>(
      'SELECT parent_revision::text FROM content.reply WHERE id=$1', [hidden.body.reply]);
    expect(parent.rows).toEqual([{ parent_revision: opener.revisionId }]);

    // A third contribution still selects the one canonical opener. Actual
    // owner work must remain constant as the thread grows, statement by statement.
    const grown = await observe(() => a.post(hiddenPage, a.reader, text, home.reader.token));
    expect(grown.status, grown.text).toBe(201);
    expect(Object.keys(grown.body).sort()).toEqual(ownResultKeys);
    expect(grown.body).toMatchObject({ profile: 'realm-about-post-v1', realm: a.realm.realm, author: a.reader });
    expect(grown.body.reply).not.toBe(hidden.body.reply);
    expect(grown.text).not.toContain(opener.reply);
    expect(grown.text).not.toContain(opener.revisionId);
    expect(grown.cost).toEqual(hidden.cost);
    expect(sqlCounts(grown.sqlTrace)).toEqual(sqlCounts(hidden.sqlTrace));

    // Only bodies are equal here: hidden/absent resource graph costs remain the known class B limit.
    // Use a readable mounted route so an about mismatch cannot reveal the hidden target first.
    const privateWork = await home.stack.privateWork(a.author, 'A private discussion target');
    const missing = `https://rezics.com/id/${randomUUID()}`;
    const hiddenTarget = await a.post({ ...absentPage, about: privateWork.work }, a.reader, text, home.reader.token);
    const absentTarget = await a.post({ ...absentPage, about: missing }, a.reader, text, home.reader.token);
    const hiddenText = await hiddenTarget.text(), absentText = await absentTarget.text();
    // No selection or effect exists. These are ordinary disclosure refusals,
    // not unknown dispatched outcomes requiring intent recovery.
    expect(hiddenTarget.status, hiddenText).toBe(404);
    expect(absentTarget.status, absentText).toBe(404);
    expect(comparableBody(hiddenText, privateWork.work)).toBe(comparableBody(absentText, missing));
    const noEffects = { threads: 0, operations: 0, replies: 0, revisions: 0 };
    expect(await a.effects(privateWork.work)).toEqual(noEffects);
    expect(await a.effects(missing)).toEqual(noEffects);
  } finally {
    prototype.query = originalQuery;
    restoreCheckoutCallers();
    await home.stop();
  }
}, 300_000);
