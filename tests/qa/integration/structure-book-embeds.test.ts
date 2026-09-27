import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

test('BOOK06: publication rejects a private transitive Content embed before activation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `book-embeds-${randomUUID()}`));
  const content = new ContentCore(f.pool);
  const observed: string[] = [];
  const tracked = new Proxy(content, { get(target, property) {
    if (property === 'readExactBatch') return async (...args: Parameters<ContentCore['readExactBatch']>) => {
      observed.push(...args[0]);
      return target.readExactBatch(...args);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
    access: f.access, content, contentAuthoring: tracked });
  const call = (path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${f.account.tokenA}`,
      'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  try {
    const makeWork = async (title: string) => {
      const work = await json<{ work: string }>(await call('/v1/works', {
        profile: 'metadata-only-v1', title, semanticTypes: ['https://schema.org/DigitalDocument'],
        actingSubject: f.actor }), 201);
      await f.grant(`content:draft:${work.work}`, 'content.draft');
      const variant = `urn:rezics:variant:${randomUUID()}`;
      await f.grant(`content:publish:${variant}`, 'content.publish');
      await f.grant(`content:search-eligibility:${variant}`, 'content.search-eligibility');
      return { work: work.work, variant };
    };
    const outer = await makeWork('Outer Book Post');
    const middle = await makeWork('Public intermediate Post');
    const leaf = await makeWork('Leaf Post');
    const duplicate = randomUUID();
    const invalid = await json<{ code: string }>(await call('/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: outer.work, variantId: outer.variant,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null, body: 'Duplicate embed',
      embeds: [duplicate, duplicate], actingSubject: f.actor,
    }), 400);
    expect(invalid.code).toBe('invalid_content_embeds');
    type Item = typeof outer;
    const save = async (item: Item, body: string, expectedHead: string | null,
      embeds: string[] = []) => json<{ revisionId: string;
      sourcePosition: { dataEpoch: string } }>(await call('/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: item.work, variantId: item.variant,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead, body, embeds, actingSubject: f.actor,
      }), 201);
    const publish = async (item: Item, saved: Awaited<ReturnType<typeof save>>,
      expectedPublicationHead: string | null) => {
      const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('exact Content revision unavailable');
      return call('/v1/content-publications', { profile: 'content-publication-v1',
        preparationId: `embed-${randomUUID()}`, revisionId: saved.revisionId,
        expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: saved.sourcePosition.dataEpoch,
        resourceId: item.work, variantId: item.variant,
        expectedPublicationHead, actingSubject: f.actor });
    };
    const eligible = async (item: Item, decision: string) => json<{ decision: string }>(
      await call('/v1/content-search-eligibility', {
        profile: 'content-search-eligibility-v1', resourceId: item.work,
        variantId: item.variant, publicationDecision: decision,
        expectedEligibilityHead: null, actingSubject: f.actor,
        rightsBasis: 'original-contribution', disclosure: 'public',
      }), 201);

    const leafFirst = await save(leaf, 'First leaf', null);
    const leafPublished = await json<{ decision: string }>(
      await publish(leaf, leafFirst, null), 201);
    await eligible(leaf, leafPublished.decision);
    const middleDraft = await save(middle, 'Middle embeds exact leaf', null,
      [leafFirst.revisionId]);
    const middlePublished = await json<{ decision: string }>(
      await publish(middle, middleDraft, null), 201);
    await eligible(middle, middlePublished.decision);

    // A newer leaf publication moves the exact public head. Its old revision is
    // still retained but its eligibility no longer authorizes new disclosure.
    const leafSecond = await save(leaf, 'Private second leaf', leafFirst.revisionId);
    await json(await publish(leaf, leafSecond, leafPublished.decision), 201);
    const outerDraft = await save(outer, 'Outer embeds middle', null,
      [middleDraft.revisionId]);
    observed.length = 0;
    const denied = await json<{ code: string }>(await publish(outer, outerDraft, null), 403);
    expect(denied.code).toBe('embed_not_public');
    expect(observed).toContain(middleDraft.revisionId);
    expect(observed).toContain(leafFirst.revisionId);
    const graph = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(outer.variant)} rv:contentPublicationHead ?decision . } }`);
    expect(graph.boolean).toBe(false);
  } finally { await f.close(); }
}, 180_000);
