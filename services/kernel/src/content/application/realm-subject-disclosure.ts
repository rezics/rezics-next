import { REALM_SUBJECT_DISCLOSURE_FRESH_MS } from '../contract/index.ts';
import type {
  RealmDisclosureContext,
  RealmDisclosurePorts,
  RealmObservation,
  RealmPreparedDisclosure,
  RealmPreparedThread,
  RealmSubjectDisclosureInput,
  RealmSubjectEvidence,
} from '../contract/index.ts';

/** Two released observation rounds over original native identities and one fixed principal. */
export function createRealmSubjectDisclosure<D, C extends RealmDisclosureContext, A>(
  ports: RealmDisclosurePorts<D, C, A>,
) {
  type Prepared = Readonly<{
    source: RealmPreparedThread<A>;
    parent: RealmObservation<A>;
    subject: RealmObservation<A>;
  }>;
  return {
    prepare,
    parent: ports.parent,
    subject: ports.subject,
    same: (before: RealmObservation<A>, after: RealmObservation<A>) =>
      before.signature === after.signature && ports.sameHome(before, after),
  };

  async function prepare(
    dependencies: D,
    input: RealmSubjectDisclosureInput,
    supplied: C,
  ): Promise<RealmPreparedDisclosure<A>> {
    const request = ports.validate(input);
    const started = ports.now();
    const context: C = {
      ...supplied,
      deadline: Math.min(supplied.deadline, supplied.work.deadline, started + REALM_SUBJECT_DISCLOSURE_FRESH_MS),
      work: supplied.work,
    };
    if (!Number.isFinite(context.deadline)) throw new TypeError('A fixed disclosure deadline is required');
    const principal = ports.principal(context);
    const requirePrincipal = () => {
      if (ports.principal(context) !== principal)
        context.work.unavailable('Content Realm Subject original principal changed');
      ports.deadline(context.deadline);
    };
    const prepared: (Prepared | RealmSubjectEvidence<A>)[] = [];
    let parent: RealmObservation<A> | null = null;
    try {
      requirePrincipal();
      parent = await ports.parent(dependencies, request.realmId, context);
      for (const candidate of request.candidates) {
        requirePrincipal();
        if (!parent) {
          prepared.push({ state: 'withheld' });
          continue;
        }
        const subject = await ports.subject(dependencies, candidate.subjectId, context);
        if (!subject) {
          prepared.push({ state: 'withheld' });
          continue;
        }
        const source = await ports.thread(dependencies, candidate, request.realmId, context);
        prepared.push(source.state === 'withheld' ? { state: 'withheld' } : { source, parent, subject });
      }
    } catch (error) {
      const state = ports.failure(error);
      prepared.splice(0, prepared.length, ...request.candidates.map(() => ({ state }) as RealmSubjectEvidence<A>));
    }
    // A consumed handle cannot be used to renew evidence after its fixed deadline
    // or under a mutated principal. This branch performs no additional native IO.
    const expiredEvidence: readonly RealmSubjectEvidence<A>[] = Object.freeze(
      request.candidates.map(() => Object.freeze({ state: 'unknown' as const })),
    );
    let finished: Promise<readonly RealmSubjectEvidence<A>[]> | undefined;
    return Object.freeze({
      finish() {
        // Memoization limits final work; it does not turn evidence into a cache.
        if (ports.now() >= context.deadline || ports.principal(context) !== principal)
          return Promise.resolve(expiredEvidence);
        return (finished ??= finish());
      },
    });

    async function finish(): Promise<readonly RealmSubjectEvidence<A>[]> {
      const results: RealmSubjectEvidence<A>[] = [];
      try {
        requirePrincipal();
        const finalParent = parent ? await ports.parent(dependencies, request.realmId, context) : null;
        for (let index = 0; index < prepared.length; index++) {
          requirePrincipal();
          const item = prepared[index]!;
          if ('state' in item) {
            results.push(item);
            continue;
          }
          if (
            !finalParent ||
            finalParent.signature !== item.parent.signature ||
            !ports.sameHome(item.parent, finalParent)
          ) {
            results.push({ state: 'withheld' });
            continue;
          }
          const candidate = request.candidates[index]!;
          const subject = await ports.subject(dependencies, candidate.subjectId, context);
          const source =
            subject && subject.signature === item.subject.signature && ports.sameHome(item.subject, subject)
              ? await item.source.final()
              : null;
          if (!subject || !source) {
            results.push({ state: 'withheld' });
            continue;
          }
          if (item.source.state === 'absent') {
            results.push({ state: 'absent' });
            continue;
          }
          const before = ports.hash([item.source.signature, item.parent.signature, item.subject.signature]);
          const final = ports.hash([source.signature, finalParent.signature, subject.signature]);
          results.push({
            state: 'positive',
            freshness: {
              before,
              final,
              expiresAt: context.deadline,
              anchors: [...source.anchors, ...finalParent.anchors, ...subject.anchors],
            },
          });
        }
        requirePrincipal();
        return Object.freeze(results.map((result) => Object.freeze(result)));
      } catch (error) {
        // No partial success after a dependency failure. In particular an absent
        // producer cannot masquerade as a complete empty population.
        const state = ports.failure(error);
        return Object.freeze(
          request.candidates.map(() =>
            Object.freeze({
              state,
            }),
          ),
        );
      }
    }
  }
}
