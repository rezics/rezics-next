import { isForegroundOperation } from './support/operation-cost.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ensureReviewedQuestionPresentation, seedScopedSubjectQuestions, scopedSubjectQuestions,
  scopedSubjectLocales, type GlobalQuestion, type ScopedSubjectApi } from '../../../scripts/dev/seed/scoped-subjects-questions.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/target-context-authority.ts';
import { QUESTION_PRESENTATION_COST, type QuestionPresentationState } from '../../../services/main/src/modules/rating/question-presentation-schema.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { scopedSubjectsFixture } from './scoped-subjects-support.ts';

const short = (ref: string) => ref.slice(-36);
const source = 'https://rezics.com/definition/scoped-subject-questions-v1';
const licence = 'https://creativecommons.org/publicdomain/zero/1.0/';

test('concurrent question seeding recovers an expired, terminally cancelled review and a settled rerun writes nothing', async () => {
  const h = await scopedSubjectsFixture();
  try {
    const api = h.api(h.owner), actor = h.owner.actor, namespace = `review-${randomUUID().slice(0, 8)}`;
    await h.authorize(GLOBAL_TARGET_CONTEXT_SCOPE, 'rating.context.create');
    const questions = new Map<string, GlobalQuestion>();
    for (const spec of scopedSubjectQuestions) {
      const created = await api.post<GlobalQuestion>('/v1/rating-contexts', {
        profile: 'realm-target-rating-context-v4', realm: GLOBAL_RATING_POPULATION_OWNER,
        question: spec.labels.en, language: 'en', targetGrain: spec.targetGrain,
        acceptedSubjectTypes: [...spec.acceptedSubjectTypes],
        ...('acceptedFrameDimensions' in spec ? { acceptedFrameDimensions: [...spec.acceptedFrameDimensions] } : {}), actingSubject: actor,
      }, `${namespace}:global-question:v1:${spec.key}`);
      questions.set(spec.key, created);
      for (const action of ['rating.question-presentation.change', 'rating.question-presentation.review'])
        await h.authorize(`rating:presentation:${created.context}`, action);
    }
    const draftState = (context: string, language: string, question: string): QuestionPresentationState =>
      ({ context, language, question, source, licence, reviewStatus: 'draft' });
    const slots = scopedSubjectQuestions.flatMap(spec => scopedSubjectLocales.filter(language => language !== 'en')
      .map(language => ({ spec, language, context: questions.get(spec.key)!, state:
        draftState(questions.get(spec.key)!.context, language, spec.labels[language]) })));
    const drafts = await Promise.all(slots.map(slot => api.post<{ component: string; revision: string }>('/v1/rating-question-presentations', {
      profile: 'rating-question-presentation-v1', expectedHead: null, actingSubject: actor, state: slot.state,
    }, `${namespace}:draft:${slot.spec.key}:${slot.language}`)));
    const french = slots.findIndex(slot => slot.spec.key === 'character' && slot.language === 'fr');
    const frenchSlot = slots[french]!, frenchDraft = drafts[french]!;
    const reviewedLanguages = async (context: string) => {
      const read = await h.stack.fuseki.query(`PREFIX rv: <${RV}>
        SELECT DISTINCT ?language WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?presentation rv:presentationContext ${iri(context)} ; rv:presentationLanguage ?language ;
            rv:questionPresentationReviewedHead ?head }
          GRAPH ${iri(GRAPHS.revisions)} { ?head rv:reviewStatus rv:Reviewed } }`);
      return (read.results?.bindings ?? []).map(row => row.language!.value).sort();
    };
    expect(await reviewedLanguages(frenchSlot.context.context)).toEqual([]);
    const lookupPath = (context: string, language: string, authenticated = true) => `/v1/rating-question-presentations?${new URLSearchParams({
      context, language, ...(authenticated ? { actingSubject: actor } : {}),
    })}`;
    expect(await h.api(null).get<{ presentation: unknown }>(lookupPath(frenchSlot.context.context, 'fr', false)))
      .toEqual({ presentation: null });
    expect(await api.get(lookupPath(frenchSlot.context.context, 'fr'))).toMatchObject({ presentation: {
      component: frenchDraft.component, revision: frenchDraft.revision, state: { reviewStatus: 'draft' },
    } });
    // Expire the same real admission after claim without sleeping for 30s. The
    // first request stays pending; its replay seals the normal cancellation.
    const claim = h.stack.access.claim.bind(h.stack.access);
    let expire = true;
    h.stack.access.claim = async (...args) => {
      const admitted = await claim(...args);
      if (expire && admitted.action === 'rating.question-presentation.review') {
        expire = false;
        const changed = await h.stack.accessPool.query<{ expires_at: Date }>(`UPDATE access.admission
          SET expires_at=registered_at+interval '1 millisecond' WHERE id=$1 RETURNING expires_at`, [admitted.id]);
        return { ...admitted, expiresAt: changed.rows[0]!.expires_at.toISOString() };
      }
      return admitted;
    };
    let failedReview: { body: object; key: string } | undefined;
    const interrupted: Pick<ScopedSubjectApi, 'get' | 'post'> = {
      get: path => api.get(path),
      post: (path, body, key) => { failedReview = { body, key }; return api.post(path, body, key); },
    };
    await expect(ensureReviewedQuestionPresentation(interrupted, actor, namespace, frenchSlot.context.context,
      frenchSlot.context.contextRevision, 'fr', frenchSlot.state.question)).rejects.toThrow('202');
    h.stack.access.claim = claim;
    expect(failedReview!.body).toMatchObject({ target: frenchDraft.component, expectedHead: frenchDraft.revision });
    const cancelled = await h.call(h.owner, 'POST', '/v1/rating-question-presentations', failedReview!.body, failedReview!.key);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ code: 'operation_cancelled' });
    expect((await h.stack.accessPool.query(`SELECT state,graph_outcome FROM access.admission
      WHERE idempotency_key=$1`, [failedReview!.key])).rows).toEqual([{ state: 'sealed', graph_outcome: 'cancelled' }]);
    expect(await reviewedLanguages(frenchSlot.context.context)).toEqual([]);
    let presentationWrites = 0;
    const transport: Pick<ScopedSubjectApi, 'get' | 'post'> = {
      get: path => api.get(path),
      post: (path, body, key) => { if (path === '/v1/rating-question-presentations') presentationWrites++; return api.post(path, body, key); },
    };
    const runs = await Promise.all(Array.from({ length: 3 }, () => seedScopedSubjectQuestions(transport, actor, namespace)));
    for (const spec of scopedSubjectQuestions) for (const language of scopedSubjectLocales) {
      const context = runs[0]![spec.key].context;
      expect(runs.every(run => run[spec.key].context === context)).toBe(true);
      const read = await h.api(null).get(`/v1/rating-contexts/${short(context)}?languages=${language}`);
      expect(read).toMatchObject({ question: spec.labels.en, displayQuestion: { language, value: spec.labels[language],
        reviewStatus: language === 'en' ? 'authored' : 'reviewed' } });
      if (language !== 'en') {
        const original = drafts[slots.findIndex(slot => slot.spec.key === spec.key && slot.language === language)]!;
        expect(runs.every(run => run[spec.key].presentations[language]!.component === original.component)).toBe(true);
      }
    }
    const writes = presentationWrites;
    for (const question of questions.values()) expect(await reviewedLanguages(question.context))
      .toEqual(scopedSubjectLocales.filter(language => language !== 'en').sort());
    await seedScopedSubjectQuestions(transport, actor, namespace);
    expect(presentationWrites).toBe(writes);
    expect((await h.call(h.owner, 'POST', '/v1/rating-question-presentations', failedReview!.body, failedReview!.key)).status).toBe(409);
    expect(await reviewedLanguages(frenchSlot.context.context))
      .toEqual(scopedSubjectLocales.filter(language => language !== 'en').sort());
    // Measure exact-head review work before and after unrelated stored data.
    const measure = async (operation: () => Promise<unknown>) => {
      const query = h.stack.fuseki.query.bind(h.stack.fuseki), command = h.stack.fuseki.commandWithReceipt.bind(h.stack.fuseki);
      let calls = 0, bytes = 0;
      const envelopes: { bytes: number; focuses: number }[] = [];
      h.stack.fuseki.query = async (...args) => { const foreground = isForegroundOperation(); if (foreground) calls++; const result = await query(...args); if (foreground) bytes += Buffer.byteLength(JSON.stringify(result)); return result; };
      h.stack.fuseki.commandWithReceipt = async envelope => { if (isForegroundOperation()) envelopes.push({ bytes: Buffer.byteLength(JSON.stringify(envelope)),
        focuses: envelope.validations.reduce((total, item) => total + item.focus.length, 0) }); return command(envelope); };
      try { await operation(); return { calls, bytes, envelopes }; }
      finally { h.stack.fuseki.query = query; h.stack.fuseki.commandWithReceipt = command; }
    };
    const createDraft = (language: string) => api.post<{ component: string; revision: string }>('/v1/rating-question-presentations', {
      profile: 'rating-question-presentation-v1', expectedHead: null, actingSubject: actor,
      state: draftState(frenchSlot.context.context, language, 'A question presentation?'),
    }, randomUUID());
    await createDraft('eo');
    const small = await measure(() => ensureReviewedQuestionPresentation(api, actor, namespace, frenchSlot.context.context,
      frenchSlot.context.contextRevision, 'eo', 'Ĉu vi ŝatas ĉi tiun rolulon?'));
    // Grow unrelated stored data while keeping each Context below its reviewed
    // language quota. The cost probe must not be a quota-overflow request.
    const unrelatedContexts = [questions.get('unit')!.context, questions.get('performance')!.context];
    for (let start = 0; start < 96; start += 8) await Promise.all(Array.from({ length: 8 }, (_, offset) =>
      api.post('/v1/rating-question-presentations', { profile: 'rating-question-presentation-v1', expectedHead: null,
        actingSubject: actor, state: { ...draftState(unrelatedContexts[(start + offset) % unrelatedContexts.length]!, `x-cost-${start + offset}`, 'Another question presentation?'),
          reviewStatus: 'reviewed' } }, randomUUID())));
    await createDraft('is');
    const large = await measure(() => ensureReviewedQuestionPresentation(api, actor, namespace, frenchSlot.context.context,
      frenchSlot.context.contextRevision, 'is', 'Hversu vel líkar þér þessi persóna?'));
    expect(large.calls).toBe(small.calls);
    for (const cost of [small, large]) {
      expect(cost.calls).toBeLessThanOrEqual(QUESTION_PRESENTATION_COST.writeGraphCalls + QUESTION_PRESENTATION_COST.lookupGraphCalls);
      expect(cost.bytes).toBeLessThanOrEqual(QUESTION_PRESENTATION_COST.writeGraphBytes + QUESTION_PRESENTATION_COST.lookupGraphBytes);
      expect(cost.envelopes).toHaveLength(1);
      expect(cost.envelopes[0]!.focuses).toBe(QUESTION_PRESENTATION_COST.validationFocuses);
      expect(cost.envelopes[0]!.bytes).toBeLessThan(QUESTION_PRESENTATION_COST.commandBytes);
    }
  } finally { await h.stop(); }
}, 300_000);
