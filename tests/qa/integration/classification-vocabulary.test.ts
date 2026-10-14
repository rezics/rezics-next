import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { VOCABULARY_COST } from '../../../services/main/src/modules/classification/vocabulary.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { readWorkClassifications } from '../../../services/main/src/modules/work/read-classifications.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { type CreateClassificationContextInput } from '../../../services/main/src/modules/classification/context.ts';
import { measureGraphReads } from './support/graph-reads.ts';
import { startHomeStack } from './feed-read-support.ts';

const short = (id: string) => id.slice(-36);
interface Defined {
  scheme: string;
  schemeHead: string;
  concept: string;
  conceptHead: string;
  sense: string;
  definitionRevision: string;
  replayed: boolean;
}
interface Page {
  name: { value: string; language: string; basis: string };
  broader: { id: string; name: { value: string } }[];
  narrower: { id: string; name: { value: string } }[];
}

test('G-426 vocabulary shares a revisioned scheme and resolves bilingual hierarchy on replay', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('classification-vocabulary');
  try {
    const { stack, author } = home;
    const deps = { ...home.deps, judgments: new AccessJudgments(stack.accessPool) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (path: string, body?: object, key?: string, token?: string) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body
              ? { 'content-type': 'application/json', 'idempotency-key': key ?? randomUUID() }
              : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    await author.grant('classification:define:global', 'classification.proposition.define');
    const rootBody = {
      profile: 'classification-proposition-v2',
      scheme: null,
      labels: [
        { language: 'en', value: 'Fiction' },
        { language: 'zh-Hans', value: '小说' },
      ],
      alternativeLabels: [{ language: 'en', value: 'Narrative fiction' }],
      broader: [],
      narrower: [],
      actingSubject: author.actor,
    };
    expect((await call('/v1/classification-vocabulary', rootBody, 'denied')).status).toBe(401);
    const queriesBefore = stack.fuseki.queries;
    const root = await home.json<Defined>(
      await call('/v1/classification-vocabulary', rootBody, 'vocabulary-root', author.token),
      201,
    );
    expect(stack.fuseki.queries - queriesBefore).toBeLessThanOrEqual(VOCABULARY_COST.graphReads);
    expect(root.schemeHead).not.toBe(root.definitionRevision);
    expect(root.conceptHead).not.toBe(root.definitionRevision);
    expect(
      await home.json<Defined>(
        await call('/v1/classification-vocabulary', rootBody, 'vocabulary-root', author.token),
        200,
      ),
    ).toMatchObject({ ...root, replayed: true });
    const childBody = {
      ...rootBody,
      scheme: { id: root.scheme, expectedHead: root.schemeHead },
      labels: [
        { language: 'en', value: 'Urban' },
        { language: 'zh-Hans', value: '都市' },
      ],
      alternativeLabels: [],
      broader: [root.concept],
    };
    const child = await home.json<Defined>(
      await call('/v1/classification-vocabulary', childBody, 'vocabulary-child', author.token),
      201,
    );
    expect(child.scheme).toBe(root.scheme);
    expect(child.schemeHead).not.toBe(root.schemeHead);
    expect(
      await home.json<Defined>(
        await call('/v1/classification-vocabulary', childBody, 'vocabulary-child', author.token),
        200,
      ),
    ).toMatchObject({ ...child, replayed: true });
    const rootPage = await home.json<Page>(
      await call(`/v1/concepts/${short(root.concept)}?language=zh-Hans`),
      200,
    );
    expect(rootPage).toMatchObject({
      name: { value: '小说', language: 'zh-Hans', basis: 'requested' },
      narrower: [{ id: child.concept, name: { value: '都市' } }],
    });
    const childPage = await home.json<Page>(
      await call(`/v1/concepts/${short(child.concept)}?language=en`),
      200,
    );
    expect(childPage).toMatchObject({
      name: { value: 'Urban', language: 'en', basis: 'requested' },
      broader: [{ id: root.concept, name: { value: 'Fiction' } }],
    });
    const fallback = await home.json<Page>(
      await call(`/v1/concepts/${short(child.concept)}?language=fr`),
      200,
    );
    expect(fallback.name).toMatchObject({ value: 'Urban', language: 'en', basis: 'fallback' });
    await author.grant('context:create:root', 'context.create');
    await author.grant(`statement:speak:${author.actor}`, 'statement.record');
    await author.grant('classification:decide:global', 'statement.decide');
    const work = await stack.publicWork(author.actor, ['en'], 'Bilingual classification');
    const interpretation = await home.json<{ context: string; semanticRevision: string }>(
      await call(
        '/v1/contexts',
        {
          profile: 'context-v1',
          role: 'shared',
          disclosure: 'public',
          base: null,
          entries: [
            {
              target: child.concept,
              relation: CLASSIFIED_AS,
              state: 'defined',
              definition: child.definitionRevision,
              applicability: [],
            },
          ],
          actingSubject: author.actor,
        },
        'vocabulary-interpretation',
        author.token,
      ),
      201,
    );
    const statementBody = {
      profile: 'statement-v1',
      speaker: { kind: 'personal' },
      subject: work.mainVersion,
      predicate: CLASSIFIED_AS,
      relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
      value: { kind: 'resource', iri: child.concept },
      applicability: [],
      interpretation: {
        kind: 'explicit',
        context: interpretation.context,
        semanticRevision: interpretation.semanticRevision,
      },
      evidence: [],
      actingSubject: author.actor,
    };
    const statement = await home.json<{
      statement: string;
      meaningKey: string;
      revision: string;
      replayed: boolean;
      meaningBasis: unknown;
      sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
    }>(await call('/v1/statements', statementBody, 'vocabulary-statement', author.token), 201);
    expect(statement.meaningBasis).toMatchObject({
      state: 'readable',
      context: interpretation.context,
      semanticRevision: interpretation.semanticRevision,
      interpretationDefinitions: [child.definitionRevision],
    });
    expect(
      await home.json<typeof statement>(
        await call('/v1/statements', statementBody, 'vocabulary-statement', author.token),
        200,
      ),
    ).toMatchObject({
      statement: statement.statement,
      meaningKey: statement.meaningKey,
      revision: statement.revision,
      sourcePosition: statement.sourcePosition,
      meaningBasis: statement.meaningBasis,
      replayed: true,
    });
    const decisionBody = {
      profile: 'statement-decision-v1',
      target: {
        kind: 'qualified-fact',
        meaningKey: statement.meaningKey,
        support: [statement.statement],
      },
      acceptance: { kind: 'global' },
      expectedDecisionHead: null,
      outcome: 'accepted',
      actingSubject: author.actor,
    };
    expect(
      (await call('/v1/statement-decisions', decisionBody, 'vocabulary-decision-denied')).status,
    ).toBe(401);
    const decision = await home.json<{
      decision: string;
      slot: string;
      revision: string;
      replayed: boolean;
    }>(
      await call('/v1/statement-decisions', decisionBody, 'vocabulary-decision', author.token),
      201,
    );
    expect(
      await home.json<typeof decision>(
        await call('/v1/statement-decisions', decisionBody, 'vocabulary-decision', author.token),
        200,
      ),
    ).toMatchObject({ ...decision, replayed: true });
    await home.json(
      await call(
        `/v1/concepts/${short(child.concept)}/spoiler-hints`,
        {
          profile: 'concept-spoiler-hint-v1',
          context: { kind: 'global' },
          hint: 'not-spoiler',
          expectedGeneration: '0',
          actingSubject: author.actor,
        },
        'vocabulary-concept-hint',
        author.token,
      ),
      201,
    );
    const chipsPath = `/v1/works/${short(work.work)}/classifications?language=zh-Hans`;
    const chipsResponse = await call(chipsPath);
    if (chipsResponse.status !== 200) {
      // Preserve the HTTP assertion and surface the concrete reader failure
      // when its public problem response intentionally omits owner details.
      await workRead(
        deps,
        new Request(`http://main.local${chipsPath}`),
        { language: 'zh-Hans' },
        (session) => readWorkClassifications(session, work.work),
      );
    }
    const chips = await home.json<{ items: { concept: string; name: { value: string } }[] }>(
      chipsResponse,
      200,
    );
    expect(chips.items).toMatchObject([{ concept: child.concept, name: { value: '都市' } }]);
    const parentBody = {
      ...rootBody,
      scheme: { id: root.scheme, expectedHead: child.schemeHead },
      labels: [{ language: 'en', value: 'Contemporary fiction' }],
      alternativeLabels: [],
      broader: [],
      narrower: [child.concept],
    };
    const parent = await home.json<Defined>(
      await call('/v1/classification-vocabulary', parentBody, 'vocabulary-parent', author.token),
      201,
    );
    const expanded = await home.json<Page>(
      await call(`/v1/concepts/${short(child.concept)}?language=en`),
      200,
    );
    expect(expanded.broader.map((item) => item.id)).toEqual([root.concept, parent.concept]);

    // A second admission cannot append against the old scheme head.
    const stale = {
      ...parentBody,
      scheme: { id: root.scheme, expectedHead: child.schemeHead },
      labels: [{ language: 'en', value: 'Stale child' }],
      narrower: [],
    };
    expect(
      (await call('/v1/classification-vocabulary', stale, 'vocabulary-stale', author.token)).status,
    ).toBe(409);
    const other = await home.json<Defined>(
      await call(
        '/v1/classification-vocabulary',
        {
          ...rootBody,
          labels: [{ language: 'en', value: 'Free tags' }],
          alternativeLabels: [],
        },
        'vocabulary-other',
        author.token,
      ),
      201,
    );
    const crossed = {
      ...parentBody,
      scheme: { id: root.scheme, expectedHead: parent.schemeHead },
      labels: [{ language: 'en', value: 'Cross scheme' }],
      narrower: [],
      broader: [other.concept],
    };
    expect(
      (await call('/v1/classification-vocabulary', crossed, 'vocabulary-crossed', author.token))
        .status,
    ).toBe(409);
    expect(
      (
        await call(
          '/v1/classification-vocabulary',
          {
            ...parentBody,
            labels: [
              { language: 'en', value: 'A' },
              { language: 'EN', value: 'B' },
            ],
          },
          'vocabulary-duplicate-locale',
          author.token,
        )
      ).status,
    ).toBe(400);
  } finally {
    await home.stop();
  }
}, 120_000);

test('Public Realm classification Context selects, replaces and clears one scheme with bounded vocabulary continuations', async () => {
  const home = await startHomeStack('realm-selected-vocabulary');
  try {
    const { author, stack, deps } = home;
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(body ? { authorization: `Bearer ${author.token}`,
        'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    await author.grant('space:create:root', 'space.create');
    await author.grant('classification:define:global', 'classification.proposition.define');
    const label = `Realm vocabulary ${randomUUID()}`;
    const define = async (value: string, prior?: Defined) => home.json<Defined>(await call('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: prior ? { id: prior.scheme, expectedHead: prior.schemeHead } : null,
      labels: [{ language: 'en', value }], alternativeLabels: [], broader: [], narrower: [], actingSubject: author.actor,
    }), 201);
    const root = await define(`${label} root`), child = await define(`${label} child`, root),
      last = await define(`${label} last`, child), excluded = await define(`${label} excluded`);
    const realmSpaces = new Map<string, string>();
    const makeRealm = async () => {
      const { realm, space } = await home.json<{ realm: string; space: string }>(await call('POST', '/v1/spaces', {
        profile: 'space-realm-v1', name: `${label} ${randomUUID()}`, capabilities: ['realm'], actingSubject: author.actor,
      }), 201);
      await author.grant(`classification:context:${realm}`, 'classification.context.configure');
      realmSpaces.set(realm, space);
      return realm;
    };
    const realm = await makeRealm(), otherRealm = await makeRealm();
    interface Configured { context: string; contextRevision: string; realm: string; scheme: string | null; replayed: boolean }
    const contextEvidence: { method: string; path: string; request: object; status: number; answer: unknown }[] = [];
    const contextRequest = async (input: CreateClassificationContextInput, key = randomUUID()) => {
      const response = await call('POST', '/v1/classification-contexts', input, key);
      const answer: unknown = await response.json();
      contextEvidence.push({ method: 'POST', path: '/v1/classification-contexts', request: input,
        status: response.status, answer });
      await Bun.write('.temp/goal/realm-context-selection-http.json', JSON.stringify(contextEvidence, null, 2));
      return { response, answer };
    };
    const configure = async (input: CreateClassificationContextInput, key = randomUUID()) => {
      const { response, answer: value } = await contextRequest(input, key);
      const answer = value as Configured;
      expect(response.status, JSON.stringify({ input, answer })).toBe(
        answer.replayed || input.profile === 'classification-context-v2' && input.expectedHead !== null ? 200 : 201);
      return answer;
    };
    const refuse = async (input: CreateClassificationContextInput, status: number, code: string, key = randomUUID()) => {
      const { response, answer } = await contextRequest(input, key);
      expect(response.status, JSON.stringify({ input, answer })).toBe(status);
      expect(answer).toMatchObject({ status, code });
      return answer;
    };
    const readContext = async (realm: string) => home.json<Omit<Configured, 'replayed'>>(
      await call('GET', `/v1/realms/${short(realm)}/classification-context`));
    const input: CreateClassificationContextInput = { profile: 'classification-context-v2',
      realm, actingSubject: author.actor, expectedHead: null, scheme: { id: root.scheme, expectedHead: last.schemeHead } };
    const anonymous = await app.handle(new Request('http://main.local/v1/classification-contexts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify(input),
    }));
    expect(anonymous.status, await anonymous.text()).toBe(401);
    const denied = await home.call('POST', '/v1/classification-contexts',
      { ...input, actingSubject: home.reader.actor }, home.reader.token);
    expect(denied.status, await denied.text()).toBe(403);
    const empty = await configure({ ...input, scheme: null });
    expect(await home.json<{ scheme: string | null; items: unknown[]; hasMore: boolean }>(await call('GET',
      `/v1/classification-vocabulary?${new URLSearchParams({ context: empty.context, limit: '1' })}`)))
      .toMatchObject({ scheme: null, items: [], hasMore: false });
    const selectionInput = { ...input, expectedHead: empty.contextRevision };
    const key = randomUUID(), selected = await configure(selectionInput, key);
    expect(selected).toMatchObject({ scheme: root.scheme, realm, replayed: false });
    expect(await configure(selectionInput, key)).toMatchObject({ ...selected, replayed: true });
    await refuse({ ...selectionInput, scheme: null }, 409, 'idempotency_conflict', key);
    await refuse(input, 409, 'stale_head');
    const shared = await configure({ ...input, realm: otherRealm });
    expect(shared.scheme).toBe(selected.scheme);
    expect(shared.context).not.toBe(selected.context);
    expect(await readContext(realm))
      .toMatchObject({ context: selected.context, contextRevision: selected.contextRevision, scheme: root.scheme });
    interface VocabularyPage { context: string; scheme: string | null; items: { id: string; label: string }[];
      hasMore: boolean; nextCursor: string | null; count: { value: number; kind: string; total: null } }
    const path = (options: Record<string, string> = {}) => `/v1/classification-vocabulary?${new URLSearchParams({
      context: selected.context!, limit: '1', language: 'en', ...options })}`;
    const firstMeasured = await measureGraphReads(
      async () => home.json<VocabularyPage>(await call('GET', path())));
    const first = firstMeasured.value;
    expect(first.scheme).toBe(root.scheme);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeString();
    const traverse = async (options: Record<string, string> = {}) => {
      const items: VocabularyPage['items'] = [];
      let cursor: string | null = null;
      for (let pages = 0; ; pages++) {
        expect(pages).toBeLessThan(100);
        const page = await home.json<VocabularyPage>(await call('GET', path({ ...options, ...(cursor ? { cursor } : {}) })));
        expect(page.items.length).toBeLessThanOrEqual(1);
        expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
        expect(page.hasMore).toBe(page.nextCursor !== null);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) return items;
      }
    };
    const expected = [root.concept, child.concept, last.concept].sort();
    expect((await traverse()).map(item => item.id).sort()).toEqual(expected);
    expect((await traverse({ context: shared.context! })).map(item => item.id).sort()).toEqual(expected);
    expect((await traverse({ scheme: excluded.scheme })).map(item => item.id)).toEqual([excluded.concept]);
    expect(await traverse({ q: 'child' })).toEqual([{ id: child.concept, label: `${label} child` }]);
    for (const change of [{ context: shared.context! }, { scheme: excluded.scheme }, { limit: '2' },
      { language: 'fr' }, { q: 'child' }])
      expect((await call('GET', path({ cursor: first.nextCursor!, ...change }))).status).toBe(400);

    const staleInput = { ...input, expectedHead: root.concept, scheme: null };
    const staleKey = randomUUID();
    await refuse(staleInput, 409, 'stale_head', staleKey);
    await refuse(staleInput, 409, 'stale_head', staleKey);
    await refuse({ ...input, expectedHead: selected.contextRevision!,
      scheme: { id: root.scheme, expectedHead: root.schemeHead } }, 409, 'stale_head');
    await refuse({ ...input, expectedHead: selected.contextRevision!,
      scheme: { id: `https://rezics.com/id/${randomUUID()}`, expectedHead: root.schemeHead } },
      404, 'classification_scheme_unavailable');
    expect((await readContext(realm))?.contextRevision).toBe(selected.contextRevision);

    const replaced = await configure({ ...input, expectedHead: selected.contextRevision!,
      scheme: { id: excluded.scheme, expectedHead: excluded.schemeHead } });
    expect(replaced.context).toBe(selected.context);
    expect(replaced.contextRevision).not.toBe(selected.contextRevision);
    expect((await call('GET', path({ cursor: first.nextCursor! }))).status).toBeOneOf([400, 409]);
    expect((await traverse()).map(item => item.id)).toEqual([excluded.concept]);
    const cleared = await configure({ ...input, expectedHead: replaced.contextRevision!, scheme: null });
    expect(await home.json<VocabularyPage>(await call('GET', path())))
      .toMatchObject({ scheme: null, items: [], hasMore: false, nextCursor: null });
    const v1Realm = await makeRealm();
    const v1 = await home.json<Configured>(await call('POST', '/v1/classification-contexts', {
      profile: 'classification-context-v1', realm: v1Realm, actingSubject: author.actor,
    }), 201);
    expect(await home.json<VocabularyPage>(await call('GET', path({ context: v1.context }))))
      .toMatchObject({ scheme: null, items: [], hasMore: false });
    expect((await traverse({ context: v1.context, scheme: root.scheme })).map(item => item.id).sort()).toEqual(expected);
    const upgraded = await configure({ ...input, realm: v1Realm, expectedHead: v1.contextRevision });
    expect(upgraded.context).toBe(v1.context);
    expect((await traverse({ context: upgraded.context })).map(item => item.id).sort()).toEqual(expected);
    const reselected = await configure({ ...input, expectedHead: cleared.contextRevision! });

    // Independent schemes do not share a compare-and-replace head. Preparation
    // stays bounded while crossing the native directory's 64-candidate window.
    for (let offset = 0; offset < 68; offset += 4)
      await Promise.all(Array.from({ length: 4 }, (_, index) => define(`${label} unrelated ${offset + index}`)));
    const largeMeasured = await measureGraphReads(
      async () => home.json<VocabularyPage>(await call('GET', path())));
    expect(largeMeasured.value.scheme).toBe(root.scheme);
    expect(largeMeasured.calls).toBeLessThanOrEqual(firstMeasured.calls + 4);
    expect((await traverse()).map(item => item.id).sort()).toEqual(expected);
    expect((await readContext(realm))?.contextRevision).toBe(reselected.contextRevision);
    const competing = await Promise.all([
      call('POST', '/v1/classification-contexts', { ...input, expectedHead: reselected.contextRevision!, scheme: null }),
      call('POST', '/v1/classification-contexts', { ...input, expectedHead: reselected.contextRevision!,
        scheme: { id: excluded.scheme, expectedHead: excluded.schemeHead } }),
    ]);
    expect(competing.map(response => response.status).sort()).toEqual([200, 409]);
    const loser = await competing.find(response => response.status === 409)!.json();
    expect(loser).toMatchObject({ code: 'stale_head' });
    const winner = await competing.find(response => response.status === 200)!.json() as Configured;
    expect((await readContext(realm))?.contextRevision).toBe(winner.contextRevision);
    await author.grant(`governance:realm:${otherRealm}`, 'realm.owner');
    await author.grant(`governance:realm:${otherRealm}`, 'governance.rule.publish');
    const space = realmSpaces.get(otherRealm)!;
    const settings = await home.json<{ generation: string }>(await home.call('GET',
      `/v1/spaces/${short(space)}/settings?actingSubject=${encodeURIComponent(author.actor)}`, undefined, author.token));
    await home.json(await call('PUT', `/v1/spaces/${short(space)}/settings`, {
      actingSubject: author.actor, expectedGeneration: settings.generation,
      settings: { visibility: 'private', listing: 'listed', admission: 'request', history: 'everything' },
      reason: 'Withhold this Realm vocabulary',
    }), 201);
    expect((await call('GET', `/v1/realms/${short(otherRealm)}/classification-context`)).status).toBe(404);
    expect(await home.json<VocabularyPage>(await call('GET', path({ context: shared.context }))))
      .toMatchObject({ scheme: null, items: [], hasMore: false, nextCursor: null });
  } finally {
    await home.stop();
  }
}, 390_000);
