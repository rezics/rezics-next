import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { measureGraphReads } from './support/graph-reads.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../../../services/main/src/modules/classification/context.ts';

type Definition = { scheme: string; schemeHead: string; concept: string; conceptHead: string };
type Page = { profile: string; context: string; scheme: string | null; items: { id: string; label: string }[];
  nextCursor: string | null; hasMore: boolean; count: { value: number; kind: string; total: null } };
const native = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('Selected context vocabulary traverses disclosed Concepts with exact query and reader continuations at two populations', async () => {
  const stack = await startMediaStack('classification-context-continuation');
  try {
    const editor = await stack.member('vocabulary-context-editor'), other = await stack.member('vocabulary-context-reader');
    const realms = new Map<string, string>();
    await editor.grant('classification:define:global', 'classification.proposition.define');
    await editor.grant('space:create:root', 'space.create');
    const context = async () => {
      const realm = (await json<{ realm: string }>(await editor.send('POST', '/v1/spaces', {
        profile: 'space-realm-v1', name: `Vocabulary context ${randomUUID()}`, capabilities: ['realm'], actingSubject: editor.actor,
      }), 201)).realm;
      await editor.grant(`classification:context:${realm}`, 'classification.context.configure');
      const selected = (await json<{ context: string }>(await editor.send('POST', '/v1/classification-contexts', {
        profile: 'classification-context-v1', realm, actingSubject: editor.actor,
      }), 201)).context;
      realms.set(selected, realm);
      return selected;
    };
    const firstContext = await context(), secondContext = await context();
    expect(await json<Page>(await stack.call('GET', `/v1/classification-vocabulary?${new URLSearchParams({
      context: firstContext, limit: '1' })}`)))
      .toMatchObject({ items: [], nextCursor: null, count: { value: 0 }, hasMore: false });
    const define = async (value: string, prior?: Definition) => json<Definition>(await editor.send('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: prior ? { id: prior.scheme, expectedHead: prior.schemeHead } : null,
      labels: [{ language: 'en', value }, { language: 'zh-Hans', value: `分类 ${value}` }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: editor.actor,
    }), 201);
    const root = await define(`Selected root ${randomUUID()}`), child = await define('Selected child', root),
      hidden = await define('Selected hidden', child), excluded = await define(`Excluded scheme ${randomUUID()}`);
    const path = (options: Record<string, string> = {}) => `/v1/classification-vocabulary?${new URLSearchParams({
      context: firstContext, scheme: root.scheme, limit: '1', language: 'en', ...options })}`;
    const first = await json<Page>(await stack.call('GET', path()));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeString();
    expect(first.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(first).toMatchObject({ context: firstContext, scheme: root.scheme, profile: 'shared-vocabulary-v1' });
    const continuation = { cursor: first.nextCursor! };
    for (const changed of [{ context: secondContext }, { scheme: excluded.scheme }, { q: 'Selected' },
      { language: 'zh-Hans' }, { limit: '2' }])
      expect((await stack.call('GET', path({ ...continuation, ...changed }))).status).toBe(400);
    expect((await stack.call('GET', path(continuation), { token: editor.token })).status).toBe(400);
    const signed = await json<Page>(await stack.call('GET', path(), { token: editor.token }));
    expect((await stack.call('GET', path({ cursor: signed.nextCursor! }), { token: other.token })).status).toBe(400);
    expect((await stack.call('GET', path({ cursor: signed.nextCursor! }))).status).toBe(400);
    expect((await stack.call('GET', path({ cursor: 'broken' }))).status).toBe(400);
    expect((await stack.call('GET', path({ limit: '21' }))).status).toBe(400);
    const traverse = async (options: Record<string, string> = {}) => {
      const items: Page['items'] = [], cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await json<Page>(await stack.call('GET', path({ ...options, ...(cursor ? { cursor } : {}) })));
        expect(page.items.length).toBeLessThanOrEqual(1);
        expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
        expect(page.hasMore).toBe(page.nextCursor !== null);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
        expect(cursors.size).toBeLessThan(100);
      } while (cursor);
      expect(new Set(items.map(item => item.id)).size).toBe(items.length);
      return items;
    };
    expect((await traverse()).map(item => item.id).sort()).toEqual([root.concept, child.concept, hidden.concept].sort());
    expect((await traverse({ scheme: excluded.scheme })).map(item => item.id)).toEqual([excluded.concept]);
    expect((await traverse({ q: 'child', language: 'zh-Hans' }))).toEqual([{ id: child.concept, label: '分类 Selected child' }]);
    expect((await traverse({ context: GLOBAL_CLASSIFICATION_CONTEXT })).map(item => item.id).sort())
      .toEqual([root.concept, child.concept, hidden.concept].sort());
    const emptyContext = native();
    expect(await json<Page>(await stack.call('GET', path({ context: emptyContext }))))
      .toMatchObject({ items: [], nextCursor: null, count: { value: 0 }, hasMore: false });
    const legacy = await json<{ items: Page['items']; hasMore: boolean }>(await stack.call('GET',
      '/v1/classification-vocabulary?q=Excluded%20scheme'));
    expect(legacy.items.some(item => item.id === excluded.concept)).toBe(true);
    expect(Object.hasOwn(legacy, 'nextCursor')).toBe(false);

    // Prepare an already reviewed exact-name restriction. This test exercises
    // disclosure consumption; Governance's Work-only name evidence intake is
    // a separate owner capability.
    await editor.grant('governance:platform', 'governance.moderate');
    const caseId = randomUUID(), decisionId = randomUUID(), digest = 'b'.repeat(64);
    await stack.accessPool.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global',
        'graph',$2,'name','private')`, [caseId, hidden.concept]);
    await stack.accessPool.query(`INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
       authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
       evidence_digest,disclosure,statement_of_reasons)
      VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,
        'platform','governance:platform',0,$5,$1::text,$5,'urn:rezics:rule:concept-name','1',$5,$5,'private',$6::jsonb)`,
      [decisionId, caseId, editor.principalId, editor.actor, digest, {
        facts: 'Withhold the selected Concept name.', scope: 'name', duration: 'Until restoration', automation: false,
        appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
        rule: { ref: 'urn:rezics:rule:concept-name', revision: '1', digest },
      }]);
    await stack.accessPool.query(`INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,revision,effect)
      VALUES ($1,1,'graph',$2,'name','exact_revision',$3,'disclosure')`, [decisionId, hidden.concept, hidden.conceptHead]);
    await stack.accessPool.query(`INSERT INTO access.governance_enforcement
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,'name',$3,
        'disclosure',$4,1,'restricted',1)`, [randomUUID(), hidden.concept, hidden.conceptHead, decisionId]);
    expect((await traverse()).map(item => item.id).sort()).toEqual([root.concept, child.concept].sort());
    const resumed = await json<Page>(await stack.call('GET', path(continuation)));
    expect(resumed.items.some(item => item.id === hidden.concept)).toBe(false);
    expect(await traverse({ q: 'Selected hidden' })).toEqual([]);

    // Build once through the command API, then measure only the foreground
    // bounded read. Each retained population uses the same selected scheme.
    let bulk = await define('Population zero');
    const bulkScheme = bulk.scheme;
    const costs: number[] = [];
    let population = 1;
    for (const size of [128, 512]) {
      while (population < size) {
        bulk = await define(`Population ${population}`, bulk);
        population++;
      }
      const measured = await measureGraphReads(() => stack.call('GET', path({ scheme: bulkScheme })));
      const page = await json<Page>(measured.value);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeString();
      expect(measured.calls).toBeLessThanOrEqual(64);
      costs.push(measured.calls);
      console.log(`Context vocabulary cost: ${JSON.stringify({ population: size, graphReads: measured.calls })}`);
    }
    expect(costs[1]).toBeLessThanOrEqual(costs[0]! + 4);
    // A previously empty lookup is live; it is not retained in a process cache.
    expect(await json<Page>(await stack.call('GET', path({ scheme: bulkScheme, limit: '20' }))))
      .toMatchObject({ count: { kind: 'exact-page', total: null } });
    const live = await json<Page>(await stack.call('GET', path()));
    const realm = realms.get(firstContext)!;
    await stack.accessPool.query(`INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,effect)
      VALUES ($1,2,'graph',$2,'record','component','disclosure')`, [decisionId, realm]);
    await stack.accessPool.query(`INSERT INTO access.governance_enforcement
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,'record',NULL,
        'disclosure',$3,2,'restricted',1)`, [randomUUID(), realm, decisionId]);
    for (const options of [{}, ...(live.nextCursor ? [{ cursor: live.nextCursor }] : [])])
      expect(await json<Page>(await stack.call('GET', path(options))))
        .toMatchObject({ items: [], nextCursor: null, count: { value: 0 }, hasMore: false });
    expect((await traverse({ context: secondContext })).map(item => item.id).sort())
      .toEqual([root.concept, child.concept].sort());
  } finally { await stack.stop(); }
}, 420_000);
