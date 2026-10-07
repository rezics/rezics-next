import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { VOCABULARY_COST } from '../../../services/main/src/modules/classification/vocabulary.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { readWorkClassifications } from '../../../services/main/src/modules/work/read-classifications.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
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
