import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import {
  QUESTION_PRESENTATION_ACTIONS,
  QUESTION_PRESENTATION_COST,
  questionPresentationScope,
} from '../../../services/main/src/modules/rating/question-presentation-schema.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { scopedJudgmentsFixture } from './scoped-judgments-support.ts';

let h: Awaited<ReturnType<typeof scopedJudgmentsFixture>>;
beforeAll(async () => {
  h = await scopedJudgmentsFixture();
}, 300_000);
afterAll(async () => {
  await h?.stop();
});

interface Write {
  component: string;
  revision: string;
}
const cost = QUESTION_PRESENTATION_COST as { reviewedLanguagesPerContext: number };

test('the language cap counts only readable, current reviews, and a configurer retires a presentation', async () => {
  const limit = cost.reviewedLanguagesPerContext;
  // The cap is a constant read at each write; a small one keeps the proof to a few writes.
  cost.reviewedLanguagesPerContext = 2;
  try {
    const q = await h.question({ realm: GLOBAL_RATING_POPULATION_OWNER, targetGrain: 'resource' });
    const scope = questionPresentationScope(q.context);
    const configurer = await h.person('presentation-configurer');
    await h.grant(h.owner, scope, QUESTION_PRESENTATION_ACTIONS[1]);
    await h.grant(h.owner, scope, QUESTION_PRESENTATION_ACTIONS[0]);
    // A configurer drafts and retires; only the owner reviews.
    await h.grant(configurer, scope, QUESTION_PRESENTATION_ACTIONS[0]);
    const post = (
      person: typeof h.owner,
      language: string,
      reviewStatus: 'draft' | 'reviewed',
      prior?: Write,
      retire?: true,
    ) =>
      h.call(person, 'POST', '/v1/rating-question-presentations', {
        profile: 'rating-question-presentation-v1',
        ...(prior ? { target: prior.component } : {}),
        expectedHead: prior?.revision ?? null,
        state: {
          context: q.context,
          language,
          question: `A question in ${language}?`,
          source: 'https://example.com/source',
          licence: 'https://example.com/licence',
          reviewStatus,
        },
        ...(retire ? { retire } : {}),
        actingSubject: person.actor,
      });
    const reviewed = async (language: string) =>
      h.json<Write>(await post(h.owner, language, 'reviewed'), 201);

    const french = await reviewed('fr'),
      german = await reviewed('de');
    expect((await post(h.owner, 'es', 'reviewed')).status).toBe(422);

    // A protected presentation is unreadable, so it no longer holds one of the slots.
    await h.stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(french.component)} rv:protectionHead ${iri(`https://rezics.com/id/${randomUUID()}`)} } }`);
    await reviewed('es');
    expect((await post(h.owner, 'it', 'reviewed')).status).toBe(422);

    // Retiring needs a reviewed presentation and a draft, never a review authority.
    expect((await post(configurer, 'it', 'draft', undefined, true)).status).toBe(400);
    expect((await post(configurer, 'de', 'reviewed', german, true)).status).toBe(400);
    const draftOnly = await h.json<Write>(await post(configurer, 'pt', 'draft'), 201);
    expect((await post(configurer, 'pt', 'draft', draftOnly, true)).status).toBe(400);
    expect((await post(configurer, 'de', 'reviewed', german)).status).toBe(403);
    const retired = await h.json<Write>(await post(configurer, 'de', 'draft', german, true), 200);
    expect(retired.revision).not.toBe(german.revision);

    // The retired language shows no review and frees its slot; the others stay.
    const read = async (language: string) =>
      h.json<{ displayQuestion: { reviewStatus: string; language: string } }>(
        await h.call(
          null,
          'GET',
          `/v1/rating-contexts/${q.context.slice(-36)}?languages=${language}`,
        ),
      );
    expect((await read('de')).displayQuestion).toMatchObject({ reviewStatus: 'authored', language: 'en' });
    expect((await read('es')).displayQuestion).toMatchObject({ reviewStatus: 'reviewed', language: 'es' });
    await h.json(await post(h.owner, 'it', 'reviewed'), 201);
    expect((await post(h.owner, 'ja', 'reviewed')).status).toBe(422);
  } finally {
    cost.reviewedLanguagesPerContext = limit;
  }
}, 300_000);
