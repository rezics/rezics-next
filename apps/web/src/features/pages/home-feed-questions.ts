import * as v from 'valibot';
import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { HomeFeedResult } from './home-feed-read';

/** Metadata identity comes from the existing exact native point route. */
export type HomeQuestion = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['rating-questions']>['get']>>['data']
>;
export const HOME_QUESTION_LIMIT = 20;
const integer = v.pipe(v.number(), v.integer());
const questionSchema: v.GenericSchema<HomeQuestion> = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  revision: v.pipe(integer, v.minValue(1), v.maxValue(2_147_483_647)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  grain: v.picklist(['work', 'release', 'episode', 'character']),
  scale: v.strictObject({ min: integer, max: integer, displayStep: v.pipe(integer, v.minValue(1)) }),
});
export type HomeQuestionPage = NonNullable<Awaited<ReturnType<KernelClient['rating-questions']['get']>>['data']>;
const directorySchema: v.GenericSchema<HomeQuestionPage> = v.strictObject({
  ratingQuestions: v.pipe(v.array(questionSchema), v.maxLength(HOME_QUESTION_LIMIT)),
  next: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(32768))),
});
export type QuestionFailure = {
  status: 'auth' | 'denied' | 'closed' | 'restart' | 'invalid' | 'lost' | 'unavailable';
  code: string;
};
export type QuestionPageResult = { status: 'ready'; page: HomeQuestionPage } | QuestionFailure;
export type QuestionPointResult = { status: 'ready'; question: HomeQuestion } | QuestionFailure;
export type HomeQuestionsReader = (cursor: string | undefined, signal: AbortSignal) => Promise<QuestionPageResult>;
export type HomeQuestionReader = (id: string, signal: AbortSignal) => Promise<QuestionPointResult>;

export function homeQuestionId(value: unknown): string | undefined {
  if (value === undefined) return;
  return v.parse(v.pipe(v.string(), v.uuid()), value);
}
function refused(status: number, error: unknown): QuestionFailure {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'dependency_unavailable';
  return {
    code,
    status:
      code === 'platform_closed'
        ? 'closed'
        : ['stale_cursor', 'search_restart_required'].includes(code)
          ? 'restart'
          : code === 'invalid_cursor' || status === 400 || status === 422
            ? 'invalid'
            : status === 401
              ? 'auth'
              : status === 403
                ? 'denied'
                : status === 404
                  ? 'lost'
                  : 'unavailable',
  };
}
function failed(error: unknown): QuestionFailure {
  return isPlatformClosedError(error)
    ? { status: 'closed', code: 'platform_closed' }
    : { status: 'unavailable', code: 'dependency_unavailable' };
}
export function questionFeedFailure(result: QuestionFailure): HomeFeedResult {
  return {
    state:
      result.status === 'auth'
        ? 'auth'
        : result.status === 'denied'
          ? 'denied'
          : result.status === 'closed'
            ? 'closed'
            : 'unavailable',
    code: result.code,
  };
}

/** One explicit bounded directory read. No option hydration, counts or eligibility inference. */
export async function readHomeQuestionPage(
  client: KernelClient,
  cursor?: string,
  authorization?: string,
  signal?: AbortSignal,
): Promise<QuestionPageResult> {
  try {
    const result = await client['rating-questions'].get({
      query: { limit: HOME_QUESTION_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
    });
    if (result.status !== 200 || result.error || !result.data) {
      const problem = refused(result.status, result.error?.value);
      // Directory failure does not establish loss of the separately selected identity.
      return problem.status === 'lost' ? { ...problem, status: 'unavailable' } : problem;
    }
    const parsed = v.safeParse(directorySchema, result.data);
    if (
      !parsed.success ||
      new Set(parsed.output.ratingQuestions.map((question) => question.id)).size !==
        parsed.output.ratingQuestions.length
    )
      return { status: 'unavailable', code: 'invalid_question_response' };
    if (cursor !== undefined && parsed.output.next === cursor)
      return { status: 'unavailable', code: 'repeated_question_cursor' };
    return { status: 'ready', page: parsed.output };
  } catch (error) {
    return failed(error);
  }
}

/** Selection/refresh only; a lost identity never becomes an unselected successful feed. */
export async function readHomeQuestion(
  client: KernelClient,
  id: string,
  authorization?: string,
  signal?: AbortSignal,
): Promise<QuestionPointResult> {
  try {
    homeQuestionId(id);
    const result = await client['rating-questions']({ questionId: id }).get({
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
    });
    if (result.status !== 200 || result.error || !result.data) return refused(result.status, result.error?.value);
    const parsed = v.safeParse(questionSchema, result.data);
    return parsed.success && parsed.output.id === id
      ? { status: 'ready', question: parsed.output }
      : { status: 'unavailable', code: 'invalid_question_response' };
  } catch (error) {
    return failed(error);
  }
}

type Snapshot = {
  status: 'idle' | 'loading' | QuestionPageResult['status'];
  page?: HomeQuestionPage;
  selected?: HomeQuestion | undefined;
  selection: 'none' | 'loading' | QuestionPointResult['status'];
  failure?: QuestionFailure | undefined;
};
/** One page plus selected metadata, with independent abortable directory and selected-point reads. */
export function createHomeQuestionChoices(
  read: HomeQuestionsReader,
  point: HomeQuestionReader,
  changed: (question: HomeQuestion | undefined, result?: QuestionPointResult) => void,
) {
  let snapshot: Snapshot = { status: 'idle', selection: 'none' };
  let generation = 0;
  let pending: AbortController | undefined;
  let selectedPending: AbortController | undefined;
  let attempted: string | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const retire = () => {
    generation++;
    if (selectedPending)
      snapshot = {
        ...snapshot,
        selection: 'unavailable',
        failure: { status: 'unavailable', code: 'question_refresh_retired' },
      };
    pending?.abort();
    selectedPending?.abort();
    pending = selectedPending = undefined;
    snapshot = {
      ...snapshot,
      status: snapshot.status === 'loading' ? (snapshot.page ? 'ready' : 'idle') : snapshot.status,
    };
  };
  const select = async (question: HomeQuestion | undefined) => {
    retire();
    snapshot = { ...snapshot, selected: question, selection: question ? 'loading' : 'none', failure: undefined };
    changed(question);
    emit();
    if (!question) return;
    const current = generation;
    const controller = new AbortController();
    selectedPending = controller;
    let result: QuestionPointResult;
    try {
      result = await point(question.id, controller.signal);
    } catch {
      result = { status: 'unavailable', code: 'dependency_unavailable' };
    }
    if (current !== generation || controller.signal.aborted) return;
    selectedPending = undefined;
    snapshot = {
      ...snapshot,
      selected: result.status === 'ready' ? result.question : question,
      selection: result.status,
      failure: result.status === 'ready' ? undefined : result,
    };
    changed(snapshot.selected, result);
    emit();
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async restore(id?: string): Promise<QuestionPointResult | undefined> {
      retire();
      if (!id) {
        snapshot = { ...snapshot, selected: undefined, selection: 'none', failure: undefined };
        emit();
        return;
      }
      try {
        homeQuestionId(id);
      } catch {
        const result: QuestionFailure = { status: 'invalid', code: 'invalid_question_id' };
        snapshot = { ...snapshot, selected: undefined, selection: result.status, failure: result };
        emit();
        return result;
      }
      const current = generation;
      const controller = new AbortController();
      selectedPending = controller;
      snapshot = { ...snapshot, selected: undefined, selection: 'loading', failure: undefined };
      emit();
      let result: QuestionPointResult;
      try {
        result = await point(id, controller.signal);
      } catch {
        result = { status: 'unavailable', code: 'dependency_unavailable' };
      }
      if (current !== generation || controller.signal.aborted) return;
      if (result.status === 'ready' && result.question.id !== id)
        result = { status: 'unavailable', code: 'invalid_question_response' };
      selectedPending = undefined;
      snapshot = {
        ...snapshot,
        selected: result.status === 'ready' ? result.question : undefined,
        selection: result.status,
        failure: result.status === 'ready' ? undefined : result,
      };
      emit();
      return result;
    },
    retire() {
      retire();
      emit();
    },
    select,
    refresh: () => select(snapshot.selected),
    async load(cursor?: string) {
      // A directory request never cancels a selected identity refresh.
      pending?.abort();
      const current = generation;
      const controller = new AbortController();
      pending = controller;
      attempted = cursor;
      snapshot = { ...snapshot, status: 'loading' };
      emit();
      let result: QuestionPageResult;
      try {
        result = await read(cursor, controller.signal);
      } catch {
        result = { status: 'unavailable', code: 'dependency_unavailable' };
      }
      if (current !== generation || controller.signal.aborted) return;
      pending = undefined;
      // Replace the old page even on failure; it is never an option history/cache.
      snapshot = {
        selected: snapshot.selected,
        selection: snapshot.selection,
        failure: snapshot.failure,
        status: result.status,
        ...(result.status === 'ready' ? { page: result.page } : {}),
      };
      if (result.status === 'ready' && snapshot.selected) {
        const observed = result.page.ratingQuestions.find((question) => question.id === snapshot.selected?.id);
        if (observed && observed.revision !== snapshot.selected.revision) {
          selectedPending?.abort();
          selectedPending = undefined;
          snapshot = { ...snapshot, selected: observed, selection: 'ready', failure: undefined };
          changed(observed, { status: 'ready', question: observed });
        }
      }
      emit();
    },
    retryCursor: () => (snapshot.status === 'restart' || snapshot.status === 'invalid' ? undefined : attempted),
  };
}
