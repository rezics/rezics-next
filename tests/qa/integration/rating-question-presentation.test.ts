import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import {
  QUESTION_PRESENTATION_ACTIONS,
  questionPresentationDigest,
  questionPresentationScope,
  type QuestionPresentationState,
} from '../../../services/main/src/modules/rating/question-presentation-schema.ts';
import { outboxEventHandlers } from '../../../services/main/src/modules/rating/outbox-event.ts';
import { GRAPHS, RV, iri, hash } from '../../../services/main/src/modules/work/activate.ts';
import { uiLocales } from '../../../apps/web/i18n/define.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/target-context-authority.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { startMediaStack } from './media-support.ts';

const short = (value: string) => value.slice(-36);
interface Context {
  context: string;
  contextRevision: string;
}
interface Write {
  component: string;
  revision: string;
  predecessor: string | null;
  receipt: string;
  replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string };
}
interface Presented {
  question: string;
  language: string;
  displayQuestion: {
    value: string;
    language: string;
    reviewStatus: string;
    presentation: { component: string; revision: string } | null;
    basis: string;
    fallback: {
      requestedLanguages: string[];
      usedLanguage: string;
      crossedScript: boolean;
      conversion: null;
    } | null;
  };
}

test('Rating question presentations preserve meaning across locales, permission boundaries, retries and concurrent revisions', async () => {
  const s = await startMediaStack('rating-question-presentation', { profileCredits: true });
  try {
    const owner = await s.member('administrator'),
      manager = await s.member('rating-manager'),
      outsider = await s.member('reader'),
      drafter = await s.member('draft-delegate');
    const members = [owner, manager, outsider, drafter];
    // Reuse the project's designated account with a fresh controlled persona
    // when an earlier file already bootstrapped it. Never replace its role or
    // designation receipt just to make this fixture the first administrator.
    const designated = (
      await s.accessPool.query<{ id: string; issuer: string; subject: string }>(`
      SELECT p.id,p.account_issuer AS issuer,p.account_subject AS subject FROM access.platform_administrator a
      JOIN access.principal p ON p.id=a.principal_id AND p.active WHERE a.singleton`)
    ).rows[0];
    if (designated) {
      owner.principal = { issuer: designated.issuer, subject: designated.subject };
      owner.principalId = designated.id;
      owner.grant = async (scope: string, action: string) => {
        const grantId = randomUUID(),
          client = await s.accessPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            'INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING',
            [scope],
          );
          const expiry =
            action === 'agent.control'
              ? 'infinity'
              : new Date(Date.now() + 3_600_000).toISOString();
          await client.query(
            `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
            VALUES($1,$2,$3,$4,$5)`,
            [randomUUID(), owner.principalId, owner.actor, action, expiry],
          );
          await client.query(
            `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
            VALUES($1,$2,$2,$3,$4,$5)`,
            [grantId, owner.actor, scope, action, expiry],
          );
          await client.query('COMMIT');
          return grantId;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
    }
    await owner.grant('work:create:root', 'agent.control');
    expect(
      (
        await new AccessPlatformAdministrators(s.accessPool).designateFirst(
          owner.principal.issuer,
          owner.principal.subject,
          () => {},
        )
      ).status,
    ).toBe(designated ? 'ignored' : 'granted');
    const app = createMainApp(s.fuseki, {
      environment: s.env,
      access: s.access,
      content: s.content,
      contentAuthoring: s.content,
      targetRatingInventory: new TargetRatingInventoryStore(s.accessPool),
      realmAdmin: new AccessRealmManagement(s.accessPool),
      account: {
        verify: async (request, scopes) => {
          const person = members.find(
            (member) => request.headers.get('authorization') === `Bearer ${member.token}`,
          );
          if (
            !person ||
            (request.headers.has('x-no-configure') && scopes.includes('rating:configure'))
          )
            throw new AccountAssertionDenied();
          const principal = { ...person.principal, emailVerified: true };
          return { ...principal, currentAssertion: async () => principal };
        },
      },
    });
    const call = (
      person: typeof owner | null,
      method: string,
      path: string,
      body?: object,
      key = randomUUID(),
      extra: Record<string, string> = {},
    ) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            ...(person ? { authorization: `Bearer ${person.token}` } : {}),
            'idempotency-key': key,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...extra,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const body = await response.text();
      if (response.status !== status)
        throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
      return JSON.parse(body) as T;
    };
    const question = 'How much did you enjoy this Work?';
    // Legacy Global standing creation retains its explicit grant; the
    // administrator role only grants Global-owned v4 target creation.
    expect(
      (
        await call(owner, 'POST', '/v1/global-rating-contexts', {
          profile: 'global-rating-standing-context-v1',
          question,
          actingSubject: owner.actor,
        })
      ).status,
    ).toBe(403);
    const globalTargetBody = {
      profile: 'realm-target-rating-context-v4',
      realm: GLOBAL_RATING_POPULATION_OWNER,
      question: 'How do you rate this subject?',
      language: 'en',
      targetGrain: 'resource',
      actingSubject: owner.actor,
    };
    expect(
      (
        await call(outsider, 'POST', '/v1/rating-contexts', {
          ...globalTargetBody,
          actingSubject: outsider.actor,
        })
      ).status,
    ).toBe(403);
    for (const profile of ['realm-target-rating-context-v2', 'realm-target-rating-context-v3']) {
      expect(
        (await call(owner, 'POST', '/v1/rating-contexts', { ...globalTargetBody, profile })).status,
      ).toBe(400);
    }
    const targetKey = randomUUID();
    const globalTarget = await json<Context>(
      await call(owner, 'POST', '/v1/rating-contexts', globalTargetBody, targetKey),
      201,
    );
    expect(
      await json(await call(owner, 'POST', '/v1/rating-contexts', globalTargetBody, targetKey)),
    ).toMatchObject({ context: globalTarget.context, replayed: true });
    const targetProof = (
      await s.accessPool.query(
        `SELECT a.scope_id FROM access.admission a
      JOIN access.platform_administrator_admission proof ON proof.admission_id=a.id
      WHERE a.principal_id=$1 AND a.action='rating.context.create' AND a.idempotency_key=$2`,
        [owner.principalId, targetKey],
      )
    ).rows;
    expect(targetProof).toEqual([{ scope_id: GLOBAL_TARGET_CONTEXT_SCOPE }]);
    const createdEvent = (
      await s.fuseki.query(`PREFIX rv: <${RV}> SELECT ?batch ?event ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:event ?event ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        ?event a rv:RatingContextCreatedEvent ; rv:receipt ?receipt . }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:ratingContext ${iri(globalTarget.context)} . }
    }`)
    ).results!.bindings[0]!;
    const creationEnvelope = await readMainOutboxEnvelope(
      s.fuseki,
      {
        batchId: createdEvent.batch!.value,
        dataEpoch: createdEvent.epoch!.value,
        sequence: createdEvent.sequence!.value,
        routingEpoch: s.env.lineage.routingEpoch,
        eventIds: [createdEvent.event!.value],
      },
      createdEvent.event!.value,
    );
    expect(creationEnvelope.data.receipt).toMatchObject({
      scope: GLOBAL_TARGET_CONTEXT_SCOPE,
      ratingContext: globalTarget.context,
      ratingContextRevision: globalTarget.contextRevision,
    });
    await json(
      await call(owner, 'POST', '/v1/rating-question-presentations', {
        profile: 'rating-question-presentation-v1',
        expectedHead: null,
        actingSubject: owner.actor,
        state: {
          context: globalTarget.context,
          language: 'eo',
          question: 'Kiel vi taksas ĉi tiun subjekton?',
          reviewStatus: 'reviewed',
          source: 'https://example.test/global-target-question',
          licence: 'https://creativecommons.org/licenses/by/4.0/',
        },
      }),
      201,
    );
    expect(
      await json(
        await call(null, 'GET', `/v1/rating-contexts/${short(globalTarget.context)}?languages=eo`),
      ),
    ).toMatchObject({
      language: 'en',
      displayQuestion: { language: 'eo', reviewStatus: 'reviewed' },
    });
    await owner.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await json<Context>(
      await call(owner, 'POST', '/v1/global-rating-contexts', {
        profile: 'global-rating-standing-context-v1',
        question,
        actingSubject: owner.actor,
      }),
      201,
    );
    const work = await s.publicWork(owner.actor, ['en'], 'Question presentation target');
    await owner.grant(`work:read:${work.work}`, 'work.read');
    await owner.grant(`rating:observe:${context.context}`, 'rating.observation.set');
    const observation = await json<{ observation: string; observationRevision: string }>(
      await call(owner, 'POST', '/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1',
        context: context.context,
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: owner.actor,
        expectedRevisionHead: null,
        value: 4,
      }),
      201,
    );
    const aggregateResponse = () =>
      call(null, 'POST', '/v1/global-rating-aggregates', {
        profile: 'global-rating-standing-latest-mean-v1',
        context: context.context,
        work: work.work,
        mainVersion: work.mainVersion,
      });
    const originalAggregate = await json<Record<string, unknown>>(await aggregateResponse());
    const anchors = async () =>
      (
        await s.fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?head ?manifest WHERE {
      GRAPH ${iri(GRAPHS.current)} { VALUES ?component { ${iri(context.context)} ${iri(observation.observation)} }
        { ?component rv:head ?head } UNION { ?component rv:observationHead ?head } }
      GRAPH ${iri(GRAPHS.revisions)} { ?head rv:component ?component ; rv:manifest ?manifest }
    } ORDER BY STR(?component)`)
      ).results!.bindings;
    const originalAnchors = await anchors();
    const state = (
      language: string,
      text: string,
      reviewStatus: 'draft' | 'reviewed' = 'reviewed',
      ctx = context.context,
    ): QuestionPresentationState => ({
      context: ctx,
      language,
      question: text,
      reviewStatus,
      source: 'https://example.test/authored-question',
      licence: 'https://creativecommons.org/licenses/by/4.0/',
    });
    const body = (presentation: QuestionPresentationState, person = owner, prior?: Write) => ({
      profile: 'rating-question-presentation-v1',
      state: presentation,
      actingSubject: person.actor,
      expectedHead: prior?.revision ?? null,
      ...(prior ? { target: prior.component } : {}),
    });
    const post = (
      presentation: QuestionPresentationState,
      person = owner,
      prior?: Write,
      key = randomUUID(),
    ) =>
      call(
        person,
        'POST',
        '/v1/rating-question-presentations',
        body(presentation, person, prior),
        key,
      );
    expect((await post(state('fr', 'Avez-vous apprécié cette œuvre ?'), outsider)).status).toBe(
      403,
    );
    expect(
      (
        await call(
          null,
          'POST',
          '/v1/rating-question-presentations',
          body(state('fr', 'Avez-vous apprécié cette œuvre ?')),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          owner,
          'POST',
          '/v1/rating-question-presentations',
          body(state('fr', 'Avez-vous apprécié cette œuvre ?')),
          randomUUID(),
          { 'x-no-configure': 'true' },
        )
      ).status,
    ).toBe(401);
    expect((await post(state('EN', 'Replacement original question?'))).status).toBe(400);
    const translated = {
      'zh-Hant': '你有多喜歡這部作品？',
      'zh-Hans': '你有多喜欢这部作品？',
      ja: 'この作品をどれくらい楽しみましたか？',
      ko: '이 작품을 얼마나 즐겼나요?',
      de: 'Wie gut hat dir dieses Werk gefallen?',
      fr: 'Avez-vous apprécié cette œuvre ?',
      es: '¿Cuánto disfrutaste esta obra?',
    };
    const writes = new Map<string, Write>();
    const nativeCommand = s.fuseki.commandWithReceipt.bind(s.fuseki);
    const costs: { focuses: number; bytes: number }[] = [];
    let loseAcknowledgement = false;
    s.fuseki.commandWithReceipt = async (envelope) => {
      const presentation = envelope.update.includes('RatingQuestionPresentationChangedEvent');
      if (presentation)
        costs.push({
          focuses: envelope.validations.reduce((n, entry) => n + entry.focus.length, 0),
          bytes: Buffer.byteLength(JSON.stringify(envelope)),
        });
      const result = await nativeCommand(envelope);
      if (presentation && loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('Lost presentation acknowledgement');
      }
      return result;
    };
    for (const [language, text] of Object.entries(translated)) {
      const key = randomUUID();
      if (language === 'fr') loseAcknowledgement = true;
      const written = await json<Write>(
        await post(state(language, text), owner, undefined, key),
        201,
      );
      writes.set(language, written);
      expect(await json(await post(state(language, text), owner, undefined, key))).toMatchObject({
        component: written.component,
        revision: written.revision,
        replayed: true,
      });
      expect((await post(state(language, `${text} Other`), owner, undefined, key)).status).toBe(
        409,
      );
    }
    for (const language of uiLocales) {
      const read = await json<Presented>(
        await call(
          null,
          'GET',
          `/v1/global-rating-contexts/${short(context.context)}?languages=${language}`,
        ),
      );
      expect(read).toMatchObject({
        question,
        language: 'en',
        displayQuestion: {
          language,
          value: language === 'en' ? question : translated[language],
          reviewStatus: language === 'en' ? 'authored' : 'reviewed',
          fallback: null,
        },
      });
      const listing = await json<{ items: Presented[] }>(
        await call(
          null,
          'GET',
          `/v1/resources/${short(work.work)}/rating-contexts?languages=${language}`,
        ),
      );
      expect(listing.items[0]).toMatchObject({
        question,
        language: 'en',
        displayQuestion: read.displayQuestion,
      });
      const contexts = await json<{ items: Presented[] }>(
        await call(null, 'GET', `/v1/rating-contexts?languages=${language}`),
      );
      expect(contexts.items[0]).toMatchObject({
        question,
        language: 'en',
        displayQuestion: read.displayQuestion,
      });
    }
    expect(
      await json(
        await call(
          null,
          'GET',
          `/v1/global-rating-contexts/${short(context.context)}`,
          undefined,
          randomUUID(),
          { 'accept-language': 'es;q=0.4, ja;q=0.9' },
        ),
      ),
    ).toMatchObject({ displayQuestion: { language: 'ja' } });
    expect(
      await json(
        await call(
          null,
          'GET',
          `/v1/global-rating-contexts/${short(context.context)}?languages=eo`,
        ),
      ),
    ).toMatchObject({
      displayQuestion: {
        value: question,
        language: 'en',
        reviewStatus: 'authored',
        fallback: { requestedLanguages: ['eo'], usedLanguage: 'en', conversion: null },
      },
    });
    await json(await post(state('eo', 'Ĉu vi ĝuis ĉi tiun verkon?')), 201);
    expect(
      await json(
        await call(
          null,
          'GET',
          `/v1/global-rating-contexts/${short(context.context)}?languages=eo`,
        ),
      ),
    ).toMatchObject({ displayQuestion: { language: 'eo', fallback: null } });
    const french = writes.get('fr')!;
    const race = await Promise.all(
      ['Aimez-vous cette œuvre ?', 'Cette œuvre vous a-t-elle plu ?'].map((text) =>
        post(state('fr', text), owner, french),
      ),
    );
    expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await json<Write>(race.find((response) => response.status === 200)!);
    expect(winner.predecessor).toBe(french.revision);
    expect((await post(state('fr', translated.fr), owner, french)).status).toBe(409);
    expect((await post(state('de', translated.de), owner, winner)).status).toBe(400);
    expect(
      await json(
        await call(
          null,
          'GET',
          `/v1/rating-question-presentations/${short(french.component)}/revisions/${short(french.revision)}`,
        ),
      ),
    ).toMatchObject({ state: { question: translated.fr, reviewStatus: 'reviewed' } });
    expect(await anchors()).toEqual(originalAnchors);
    const { sourcePosition: _before, ...before } = originalAggregate;
    const { sourcePosition: _after, ...after } = await json<Record<string, unknown>>(
      await aggregateResponse(),
    );
    expect(after).toEqual(before);
    expect(after).toMatchObject({ count: 1, sum: 4, mean: 4 });
    expect(costs.every((cost) => cost.focuses === 2 && cost.bytes < 32_768)).toBe(true);
    expect(costs.length).toBeGreaterThan(8);
    expect(outboxEventHandlers[0]!.actions).toContain(QUESTION_PRESENTATION_ACTIONS[1]);

    const creationRace = await Promise.all(
      ['Да ли сте уживали?', 'Да ли вам се свиђа?'].map((text) => post(state('sr-Cyrl', text))),
    );
    expect(creationRace.map((response) => response.status).sort()).toEqual([201, 409]);
    const sparse = await json<Context>(
      await call(owner, 'POST', '/v1/global-rating-contexts', {
        profile: 'global-rating-standing-context-v1',
        question: 'Another exact question?',
        actingSubject: owner.actor,
      }),
      201,
    );
    await json(await post(state('zh-Hans', '你喜欢这个问题吗？', 'reviewed', sparse.context)), 201);
    expect(
      await json(
        await call(
          null,
          'GET',
          `/v1/global-rating-contexts/${short(sparse.context)}?languages=zh-Hant`,
        ),
      ),
    ).toMatchObject({
      displayQuestion: {
        language: 'zh-Hans',
        basis: 'other-script',
        fallback: { crossedScript: true, usedLanguage: 'zh-Hans', conversion: null },
      },
    });

    const eventId = `urn:rezics:event:${hash(`${winner.receipt}\0semantic-write`)}`;
    const terminalRows = (
      await s.fuseki
        .query(`PREFIX rv: <${RV}> SELECT ?admissionId ?digest ?authorityEpoch ?scope ?outcome ?epoch ?sequence ?expectedHead WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(winner.receipt)} rv:admissionId ?admissionId ; rv:requestDigest ?digest ; rv:authorityEpoch ?authorityEpoch ;
        rv:admittedScope ?scope ; rv:outcome ?outcome ; rv:dataEpoch ?epoch ; rv:sequence ?sequence ; rv:expectedHead ?expectedHead }
    }`)
    ).results!.bindings;
    const eventValues = {
      ...Object.fromEntries(
        Object.entries(terminalRows[0]!).map(([key, value]) => [key, value.value]),
      ),
      receipt: winner.receipt,
      action: QUESTION_PRESENTATION_ACTIONS[1],
    };
    const event = await outboxEventHandlers[0]!.read({
      fuseki: s.fuseki,
      batch: {
        batchId: `urn:rezics:outbox:${hash(winner.receipt)}`,
        dataEpoch: winner.sourcePosition.dataEpoch,
        sequence: winner.sourcePosition.sequence,
        routingEpoch: s.env.lineage.routingEpoch,
        eventIds: [eventId],
      },
      eventId,
      ordinal: 0,
      value: (name) => eventValues[name as keyof typeof eventValues],
    });
    expect(event.data.receipt).toMatchObject({
      context: context.context,
      action: QUESTION_PRESENTATION_ACTIONS[1],
      revision: winner.revision,
    });

    // An explicitly delegated draft action cannot keep or set reviewed status.
    await drafter.grant(
      questionPresentationScope(context.context),
      QUESTION_PRESENTATION_ACTIONS[0],
    );
    const draft = await json<Write>(
      await post(state('ar', 'هل استمتعت بهذا العمل؟', 'draft'), drafter),
      201,
    );
    expect((await post(state('ar', 'هل استمتعت بهذا العمل؟'), drafter, draft)).status).toBe(403);
    expect(
      (await call(null, 'GET', `/v1/rating-question-presentations/${short(draft.component)}`))
        .status,
    ).toBe(404);
    expect(
      await json(
        await call(
          drafter,
          'GET',
          `/v1/rating-question-presentations/${short(draft.component)}?actingSubject=${encodeURIComponent(drafter.actor)}`,
        ),
      ),
    ).toMatchObject({ state: { reviewStatus: 'draft' } });
    expect(
      await json(
        await call(
          null,
          'GET',
          `/v1/global-rating-contexts/${short(context.context)}?languages=ar`,
        ),
      ),
    ).toMatchObject({ displayQuestion: { language: 'en', reviewStatus: 'authored' } });
    const reviewed = await json<Write>(
      await post(state('ar', 'هل استمتعت بهذا العمل؟'), owner, draft),
    );
    expect(reviewed.predecessor).toBe(draft.revision);

    // Realm managers use their Realm role proof for both independent actions,
    // including language-tagged targets that are not rv:RatingContext subjects.
    const realm = (
      await json<{ realm: string }>(
        await call(owner, 'POST', '/v1/spaces', {
          profile: 'space-realm-v1',
          name: 'Question presentation Realm',
          language: 'ja',
          capabilities: ['realm'],
          actingSubject: owner.actor,
        }),
        201,
      )
    ).realm;
    await json(
      await call(owner, 'POST', `/v1/realms/${short(realm)}/management`, {
        actingSubject: owner.actor,
      }),
    );
    const grant = await manager.grant(`governance:realm:${realm}`, 'rating.configure');
    const target = (
      await json<{ component: string }>(
        await call(owner, 'POST', '/v1/semantic/changes', {
          profile: 'semantic-change-v1',
          expectedHead: null,
          actingSubject: owner.actor,
          state: {
            component: 'resource',
            types: ['https://rezics.com/vocab/Character'],
            properties: [
              {
                predicate: 'https://schema.org/name',
                value: {
                  kind: 'language-string',
                  lexical: 'キリト',
                  language: 'ja',
                  direction: 'ltr',
                },
              },
            ],
          },
        }),
        201,
      )
    ).component;
    await owner.grant(`semantic:read:${target}`, 'semantic.read');
    const realmContext = await json<Context>(
      await call(manager, 'POST', '/v1/rating-contexts', {
        profile: 'realm-target-rating-context-v2',
        realm,
        question: 'この人物の評価は？',
        language: 'ja',
        targetGrain: 'resource',
        actingSubject: manager.actor,
      }),
      201,
    );
    expect(
      (
        await post(
          state('en', 'How do you rate this character?', 'reviewed', realmContext.context),
          outsider,
        )
      ).status,
    ).toBe(403);
    const realmDraft = await json<Write>(
      await post(
        state('en', 'How do you rate this character?', 'draft', realmContext.context),
        manager,
      ),
      201,
    );
    const realmReviewBody = body(
      state('en', 'How do you rate this character?', 'reviewed', realmContext.context),
      manager,
      realmDraft,
    );
    const reviewKey = randomUUID();
    const realmReviewed = await json<Write>(
      await call(manager, 'POST', '/v1/rating-question-presentations', realmReviewBody, reviewKey),
    );
    expect(
      await json(
        await call(
          manager,
          'POST',
          '/v1/rating-question-presentations',
          realmReviewBody,
          reviewKey,
        ),
      ),
    ).toMatchObject({ revision: realmReviewed.revision, replayed: true });
    expect(
      await json(
        await call(null, 'GET', `/v1/rating-contexts/${short(realmContext.context)}?languages=en`),
      ),
    ).toMatchObject({
      question: 'この人物の評価は？',
      language: 'ja',
      displayQuestion: {
        value: 'How do you rate this character?',
        language: 'en',
        reviewStatus: 'reviewed',
      },
    });
    const targetPage = await json<{ items: Presented[] }>(
      await call(
        owner,
        'GET',
        `/v1/resources/${short(target)}/rating-contexts?scope=realm&realm=${encodeURIComponent(realm)}&actingSubject=${encodeURIComponent(owner.actor)}&languages=en`,
      ),
    );
    expect(targetPage.items[0]).toMatchObject({
      language: 'ja',
      displayQuestion: { language: 'en' },
    });
    expect(
      (await post(state('JA', '別の質問ですか？', 'reviewed', realmContext.context), manager))
        .status,
    ).toBe(400);
    const pending = [];
    for (const reviewStatus of ['draft', 'reviewed'] as const) {
      const input = state(
        reviewStatus === 'draft' ? 'de' : 'fr',
        'A pending translation?',
        reviewStatus,
        realmContext.context,
      );
      const request = {
        principal: { ...manager.principal, emailVerified: true },
        actingSubject: manager.actor,
        action:
          reviewStatus === 'draft'
            ? QUESTION_PRESENTATION_ACTIONS[0]
            : QUESTION_PRESENTATION_ACTIONS[1],
        scope: questionPresentationScope(realmContext.context),
        idempotencyKey: randomUUID(),
        requestDigest: questionPresentationDigest(undefined, null, input),
      };
      pending.push({ request, admission: await s.access.register(request) });
    }
    await s.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      grant,
    ]);
    for (const entry of pending) {
      await expect(s.access.claim(entry.admission.id, entry.request.requestDigest)).rejects.toThrow(
        'Realm rating authority changed',
      );
      expect(await s.access.register(entry.request)).toMatchObject({
        id: entry.admission.id,
        replayed: true,
        dispatchEligible: false,
      });
    }
    expect(
      (
        await post(
          state('en', 'New wording?', 'reviewed', realmContext.context),
          manager,
          realmReviewed,
        )
      ).status,
    ).toBe(403);
    // Platform administration is limited to Global presentation ownership.
    await s.accessPool.query(
      "UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'rating.configure'",
      [owner.actor, `governance:realm:${realm}`],
    );
    expect(
      (
        await post(
          state('en', 'New wording?', 'reviewed', realmContext.context),
          owner,
          realmReviewed,
        )
      ).status,
    ).toBe(403);
    s.fuseki.commandWithReceipt = nativeCommand;
  } finally {
    await s.stop();
  }
}, 120_000);
