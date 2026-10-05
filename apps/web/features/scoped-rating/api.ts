import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { idOf } from '../work-page/route.ts';
import { nameOccurrences } from './occurrence-names.ts';
import { failureOf, type Failure, type Outcome, type ProjectionView, type Question, type ResourceSummary, type Rollup,
  type RollupFormula, type TargetRating } from './types.ts';

// What the scoped rating components ask of Main, through the BFF (which carries the session). Stories supply an
// in-memory one (`fixtures.ts`). Every write carries an `Idempotency-Key`, and a rating carries the revision head it
// replaces so two devices cannot silently overwrite each other: Main answers one's own value and head with the
// figures (`scope=mine`), and a stale write with the head to retry on, so no device needs to remember either.

/** Whose ratings a question collects. Global questions are everyone's; a Realm's are its own population's. */
export type QuestionScope = { kind: 'global' } | { kind: 'realm'; realm: string };

export interface ProjectionRead { projection: ProjectionView; summary: ResourceSummary | null }
export interface ProjectionList { items: ProjectionRead[]; nextCursor: string | null }

/** What a rating write left behind: the value Main holds, and whether Main has applied it yet. */
export interface Rated { value: number | null; pending: boolean }

/** The signed-in person's own standing rating of a target for a question; `value` is null before a first rating and after a withdrawal. */
export interface OwnRating { value: number | null }

export interface ScopedRatingApi {
  /** The one projection of a subject within frames, created on first use. */
  projection: (subject: string, frames: readonly string[]) => Promise<Outcome<ProjectionRead & { created: boolean }>>;
  /** A subject's projections, newest identity first, a page at a time. */
  projections: (subject: string, cursor?: string | null) => Promise<Outcome<ProjectionList>>;
  /** The questions that accept this target, in the scope's population. */
  questions: (target: string, scope: QuestionScope) => Promise<Outcome<Question[]>>;
  /** One question's figures for one target. */
  rating: (target: string, question: string, scope: QuestionScope) => Promise<Outcome<TargetRating>>;
  /** Sets (1–10) or withdraws (null) the signed-in person's rating of a target for a question. */
  rate: (target: string, question: string, value: number | null) => Promise<Outcome<Rated>>;
  /** The person's own rating of the target for the question, as Main holds it, so any device shows the same value. */
  own: (target: string, question: string) => Promise<Outcome<OwnRating>>;
  /** A derived metric over targets of one question; nothing is stored. */
  rollup: (question: string, targets: readonly string[], formula: RollupFormula, rank?: boolean) => Promise<Outcome<Rollup>>;
}

type Answer<T> = { data: T | null; error: { status: number; value?: unknown } | null };

async function answered<T>(call: () => Promise<Answer<T>>): Promise<Answer<T>> {
  try { return await call(); } catch { return { data: null, error: { status: 503 } }; }
}

async function settle<T>(call: () => Promise<Answer<T>>): Promise<Outcome<T>> {
  const answer = await answered(call);
  return answer.data ? { ok: true, data: answer.data } : { ok: false, failure: failureOf(answer.error?.status ?? 503) };
}

/** The head a refused write names as the current one (`stale_head`), or null where the problem names none. */
function currentHeadOf(error: Answer<unknown>['error']): string | null {
  const body = error?.status === 409 ? error.value : null;
  return body && typeof body === 'object' && 'code' in body && body.code === 'stale_head'
    && 'currentHead' in body && typeof body.currentHead === 'string' ? body.currentHead : null;
}

const key = () => crypto.randomUUID();
const uuidOf = (iri: string) => idOf(iri) ?? iri.slice(-36);
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** A write Access has admitted but whose owner has not applied it answers 202 with where to look again. */
const pending = (data: object): data is { retry: { afterMs: number } } => 'retry' in data;

/** Main answers 202 while a racing first creation settles; ask again this many times before giving up. */
const RECONCILE_ATTEMPTS = 5;

/**
 * The adapter over Main for a signed-in person acting as `actingSubject`, or for a reader with none (`null`): reads
 * are public, writes then report `sign-in`.
 */
export function mainScopedRatingApi({ actingSubject, main = browserMainApi, locale = 'en' }: {
  actingSubject: string | null; main?: () => MainClient;
  /** The language episodes and chapters are named in, when their reading order has a label for it. */
  locale?: UiLocale;
}): ScopedRatingApi {
  const reader = actingSubject ? { actingSubject } : {};
  // The head each of this person's ratings stands at, as Main last said: from the own read or the last write.
  const heads = new Map<string, string | null>();
  const slot = (target: string, question: string) => `${question}\n${target}`;

  async function readOwn(target: string, question: string): Promise<Outcome<OwnRating>> {
    if (!actingSubject) return { ok: false, failure: 'sign-in' };
    const answer = await settle(() => main().v1.resources({ resource: uuidOf(target) }).ratings
      .get({ query: { scope: 'mine', context: question, actingSubject } }));
    if (!answer.ok) return answer;
    if (!('targetGrain' in answer.data)) return { ok: false, failure: 'invalid' };
    const own = answer.data.own ?? null;
    heads.set(slot(target, question), own?.revisionHead ?? null);
    return { ok: true, data: { value: own?.availability === 'available' ? own.value : null } };
  }

  const scopeQuery = (scope: QuestionScope) => scope.kind === 'global' ? { scope: 'global' as const }
    : { scope: 'realm' as const, realm: scope.realm };

  const orders = new Map<string, Promise<Map<string, { value: string; language: string }[]>>>();
  /** A summary names an episode after its Work; these give each place's episodes and chapters the names their story does. */
  const named = (summaries: readonly (ResourceSummary | null)[]) => nameOccurrences(main(), summaries, locale,
    actingSubject ?? undefined, orders).catch(() => [...summaries]);

  async function summaryOf(projection: string): Promise<ResourceSummary | null> {
    const batch = await settle(() => main().v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: [projection], ...reader }));
    return batch.ok ? (await named([batch.data.summaries[0] ?? null]))[0] ?? null : null;
  }

  return {
    async projection(subject, frames) {
      if (!actingSubject) return { ok: false, failure: 'sign-in' };
      // One key for the whole attempt: Main replays a command it already admitted, and a first use that races
      // another settles into the one projection (`projection/README.md#identity`).
      let idempotencyKey = key();
      for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt += 1) {
        const answer = await settle(() => main().v1.projections.post({ subject, frames: [...frames], actingSubject },
          { headers: { 'idempotency-key': idempotencyKey } }));
        if (!answer.ok) {
          // Authority moved under the command: ask again once as a new command.
          if (answer.failure === 'conflict' && attempt === 0) { idempotencyKey = key(); continue; }
          return answer;
        }
        if ('projection' in answer.data) {
          const { projection, created } = answer.data;
          return { ok: true, data: { projection, created, summary: await summaryOf(projection.id) } };
        }
        await pause(pending(answer.data) ? answer.data.retry.afterMs : 1000);
      }
      return { ok: false, failure: 'unavailable' };
    },

    async projections(subject, cursor) {
      const page = await settle(() => main().v1.projections.get({ query: { subject, limit: 20, ...cursor ? { cursor } : {}, ...reader } }));
      if (!page.ok) return page;
      const summaries = new Map<string, ResourceSummary>();
      if (page.data.items.length) {
        const batch = await settle(() => main().v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
          resources: page.data.items.map(item => item.id), ...reader }));
        if (batch.ok) for (const summary of await named(batch.data.summaries)) if (summary) summaries.set(summary.reference, summary);
      }
      return { ok: true, data: { nextCursor: page.data.nextCursor,
        items: page.data.items.map(projection => ({ projection, summary: summaries.get(projection.id) ?? null })) } };
    },

    async questions(target, scope) {
      const items: Question[] = [];
      let cursor: string | undefined;
      // Twenty a page; a target has a handful of questions, so this ends at the first or second page.
      for (let page = 0; page < 5; page += 1) {
        const answer = await settle(() => main().v1.resources({ resource: uuidOf(target) })['rating-contexts']
          .get({ query: { ...scopeQuery(scope), ...cursor ? { cursor } : {}, ...reader } }));
        if (!answer.ok) return answer;
        items.push(...answer.data.items);
        if (!answer.data.nextCursor) break;
        cursor = answer.data.nextCursor;
      }
      return { ok: true, data: items };
    },

    async rating(target, question, scope) {
      const answer = await settle(() => main().v1.resources({ resource: uuidOf(target) }).ratings
        .get({ query: { ...scopeQuery(scope), context: question, ...reader } }));
      if (!answer.ok) return answer;
      return 'targetGrain' in answer.data ? { ok: true, data: answer.data } : { ok: false, failure: 'invalid' };
    },

    async rate(target, question, value) {
      if (!actingSubject) return { ok: false, failure: 'sign-in' };
      const at = slot(target, question);
      // A device that has not read the rating learns its head first, so a first write on a new device does not conflict.
      if (!heads.has(at)) {
        const known = await readOwn(target, question);
        if (!known.ok) return known;
      }
      let head = heads.get(at) ?? null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await answered(() => main().v1['rating-observations'].post({
          profile: 'realm-target-rating-observation-v1', context: question, target, expectedRevisionHead: head, value,
          actingSubject }, { headers: { 'idempotency-key': key() } }));
        if (answer.data) {
          // A write Access admitted but has not applied answers 202 without a revision: the next write then reads the
          // head again, and Main says so if this one has landed meanwhile.
          const revision = 'observationRevision' in answer.data ? answer.data.observationRevision : null;
          if (revision) heads.set(at, revision); else heads.delete(at);
          return { ok: true, data: { value, pending: revision === null } };
        }
        const current = currentHeadOf(answer.error);
        // Another device or press wrote first: apply this choice once on the head Main names, never over an unknown one.
        if (current === null || current === head) return { ok: false, failure: failureOf(answer.error?.status ?? 503) };
        head = current;
      }
      return { ok: false, failure: 'conflict' as Failure };
    },

    own: readOwn,

    rollup: (question, targets, formula, rank = false) => settle(() => main().v1['rating-rollups'].post({
      profile: 'rating-rollup-v1', context: question, targets: [...targets], formula, rank, ...reader })),
  };
}
