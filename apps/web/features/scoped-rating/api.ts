import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { idOf } from '../work-page/route.ts';
import { failureOf, type Failure, type Outcome, type ProjectionView, type Question, type ResourceSummary, type Rollup,
  type RollupFormula, type TargetRating } from './types.ts';

// What the scoped rating components ask of Main, through the BFF (which carries the session). Stories supply an
// in-memory one (`fixtures.ts`). The patterns are the reader library's (`catalogue/reader-store.ts`): every write
// carries an `Idempotency-Key`, and a rating carries the revision head it replaces so two devices cannot silently
// overwrite each other.

/** Whose ratings a question collects. Global questions are everyone's; a Realm's are its own population's. */
export type QuestionScope = { kind: 'global' } | { kind: 'realm'; realm: string };

export interface ProjectionRead { projection: ProjectionView; summary: ResourceSummary | null }
export interface ProjectionList { items: ProjectionRead[]; nextCursor: string | null }

/** What a rating write left behind: the value Main holds, and whether Main has applied it yet. */
export interface Rated { value: number | null; pending: boolean }

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
  /** The value this person last saved for the target, if this device knows it. */
  own: (target: string, question: string) => number | null;
  /** A derived metric over targets of one question; nothing is stored. */
  rollup: (question: string, targets: readonly string[], formula: RollupFormula, rank?: boolean) => Promise<Outcome<Rollup>>;
}

type Answer<T> = { data: T | null; error: { status: number } | null };

async function settle<T>(call: () => Promise<Answer<T>>): Promise<Outcome<T>> {
  try {
    const { data, error } = await call();
    if (data) return { ok: true, data };
    return { ok: false, failure: failureOf(error?.status ?? 503) };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

const key = () => crypto.randomUUID();
const uuidOf = (iri: string) => idOf(iri) ?? iri.slice(-36);
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** A write Access has admitted but whose owner has not applied it answers 202 with where to look again. */
const pending = (data: object): data is { retry: { afterMs: number } } => 'retry' in data;

/**
 * Where a person's own ratings are remembered between reads. Main answers a rating write against a head the writer
 * names but offers no read of the writer's own head for a target, so the head and value the last write returned are
 * kept here: in memory in stories, per browser for people.
 */
export interface OwnRatings {
  get: (actingSubject: string, question: string, target: string) => { value: number | null; revision: string } | null;
  set: (actingSubject: string, question: string, target: string, own: { value: number | null; revision: string } | null) => void;
}

export function memoryOwnRatings(initial: Record<string, { value: number | null; revision: string }> = {}): OwnRatings {
  const known = new Map(Object.entries(initial));
  const at = (actingSubject: string, question: string, target: string) => `${actingSubject}\n${question}\n${target}`;
  return {
    get: (actingSubject, question, target) => known.get(at(actingSubject, question, target)) ?? null,
    set(actingSubject, question, target, own) {
      if (own) known.set(at(actingSubject, question, target), own);
      else known.delete(at(actingSubject, question, target));
    },
  };
}

export function browserOwnRatings(): OwnRatings {
  const at = (actingSubject: string, question: string, target: string) => `scoped-rating:${actingSubject}:${question}:${target}`;
  return {
    get(actingSubject, question, target) {
      try {
        const text = localStorage.getItem(at(actingSubject, question, target));
        const parsed: unknown = text ? JSON.parse(text) : null;
        return parsed && typeof parsed === 'object' && 'revision' in parsed && typeof parsed.revision === 'string'
          && 'value' in parsed && (parsed.value === null || typeof parsed.value === 'number')
          ? { value: parsed.value, revision: parsed.revision } : null;
      } catch { return null; }
    },
    set(actingSubject, question, target, own) {
      try {
        if (own) localStorage.setItem(at(actingSubject, question, target), JSON.stringify(own));
        else localStorage.removeItem(at(actingSubject, question, target));
      } catch { /* Storage is full or disabled: the next write then conflicts and says so. */ }
    },
  };
}

/** Main answers 202 while a racing first creation settles; ask again this many times before giving up. */
const RECONCILE_ATTEMPTS = 5;

/**
 * The adapter over Main for a signed-in person acting as `actingSubject`, or for a reader with none (`null`): reads
 * are public, writes then report `sign-in`.
 */
export function mainScopedRatingApi({ actingSubject, own = browserOwnRatings(), main = browserMainApi }: {
  actingSubject: string | null; own?: OwnRatings; main?: () => MainClient;
}): ScopedRatingApi {
  const reader = actingSubject ? { actingSubject } : {};
  const scopeQuery = (scope: QuestionScope) => scope.kind === 'global' ? { scope: 'global' as const }
    : { scope: 'realm' as const, realm: scope.realm };

  async function summaryOf(projection: string): Promise<ResourceSummary | null> {
    const batch = await settle(() => main().v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: [projection], ...reader }));
    return batch.ok ? batch.data.summaries[0] ?? null : null;
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
        if (batch.ok) for (const summary of batch.data.summaries) summaries.set(summary.reference, summary);
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
      const post = (head: string | null) => settle(() => main().v1['rating-observations'].post({
        profile: 'realm-target-rating-observation-v1', context: question, target, expectedRevisionHead: head, value,
        actingSubject }, { headers: { 'idempotency-key': key() } }));
      let head = own.get(actingSubject, question, target)?.revision ?? null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await post(head);
        if (answer.ok) {
          // A write Access admitted but has not applied answers 202 without a revision: the next write then names
          // no head, and Main says so if this one has landed meanwhile.
          const revision = 'observationRevision' in answer.data ? answer.data.observationRevision : null;
          own.set(actingSubject, question, target, revision && value !== null ? { value, revision }
            : revision ? { value: null, revision } : null);
          return { ok: true, data: { value, pending: revision === null } };
        }
        if (answer.failure !== 'conflict') return answer;
        // Another press on this device may have landed first: read what it left and apply this choice on top.
        const fresh = own.get(actingSubject, question, target)?.revision ?? null;
        if (fresh === head) return answer;
        head = fresh;
      }
      return { ok: false, failure: 'conflict' as Failure };
    },

    own: (target, question) => actingSubject ? own.get(actingSubject, question, target)?.value ?? null : null,

    rollup: (question, targets, formula, rank = false) => settle(() => main().v1['rating-rollups'].post({
      profile: 'rating-rollup-v1', context: question, targets: [...targets], formula, rank, ...reader })),
  };
}
