import type {
  RealmDisclosureContext,
  RealmObservation,
  RealmPreparedDisclosure,
  RealmSearchDisclosure,
  RealmSearchPorts,
  RealmSubjectDisclosureInput,
  RealmWork,
} from '../contract/index.ts';
const pointBound = (values: Partial<RealmWork>): RealmWork => ({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  ...values,
});

function bounds() {
  return Object.freeze({
    resolve: pointBound({
      candidateKeys: 16,
      nativeRows: 512,
      emptySeeks: 16,
      nativePoints: 256,
      statements: 256,
      bytes: 512 * 1024,
    }),
    current: pointBound({
      candidateKeys: 16,
      nativeRows: 512,
      emptySeeks: 16,
      nativePoints: 256,
      statements: 256,
      bytes: 512 * 1024,
    }),
    subject: pointBound({
      candidateKeys: 8,
      nativeRows: 128,
      emptySeeks: 8,
      nativePoints: 64,
      statements: 64,
      bytes: 256 * 1024,
    }),
    candidate: pointBound({
      candidateKeys: 128,
      nativeRows: 4096,
      emptySeeks: 128,
      nativePoints: 1024,
      witnessKeys: 1024,
      statements: 1024,
      bytes: 1024 * 1024,
    }),
  });
}

/** Request-bound exact disclosure; the native source retains its original sparse cursor and lifecycle. */
export function createRealmSubjectSearch<P, R, W, D, C extends RealmDisclosureContext, S, A>(
  ports: RealmSearchPorts<P, R, W, D, C, S>,
  exact: {
    parent(dependencies: D, realm: string, context: C): Promise<RealmObservation<A> | null>;
    subject(dependencies: D, subject: string, context: C): Promise<RealmObservation<A> | null>;
    same(before: RealmObservation<A>, after: RealmObservation<A>): boolean;
    prepare(dependencies: D, input: RealmSubjectDisclosureInput, context: C): Promise<RealmPreparedDisclosure<A>>;
  },
) {
  const limits = bounds();
  return { source };
  function source(input: { pool: P; reader: R }): S | undefined {
    const dependencies = ports.reader(input.pool, input.reader);
    if (dependencies === undefined) return undefined;
    const reader = input.reader;
    const parents = new Map<string, { realm: string; observation: RealmObservation<A> }>();
    let nextDependency = 0;

    const disclosure: RealmSearchDisclosure<R, W> = {
      bounds: limits,
      async resolve(realm, context) {
        try {
          const result = await ports.withWork(reader, context.work, limits.resolve, (native) =>
            exact.parent(dependencies, realm, native),
          );
          if (!result) return { state: 'concealed' };
          const dependency = ports.dependency(realm, result.signature, ++nextDependency);
          parents.set(dependency, { realm, observation: result });
          return { state: 'ready', dependency };
        } catch (error) {
          const state = ports.failure(error);
          if (state) return { state };
          throw error;
        }
      },
      async current(realm, dependency, context) {
        const retained = parents.get(dependency);
        if (!retained || retained.realm !== realm) return 'changed';
        try {
          const after = await ports.withWork(reader, context.work, limits.current, (native) =>
            exact.parent(dependencies, realm, native),
          );
          if (!after) return 'concealed';
          return exact.same(retained.observation, after) ? 'current' : 'changed';
        } catch (error) {
          const state = ports.failure(error);
          if (state === 'concealed') return 'concealed';
          if (state === 'unavailable') return 'unavailable';
          throw error;
        }
      },
      async candidate(candidate, dependency, context) {
        const [result] = await this.candidates!([candidate], dependency, context);
        return result!;
      },
      async candidates(candidates, dependency, context) {
        const realm = parents.get(dependency);
        if (!realm || candidates.length < 1 || candidates.length > 8) return candidates.map(() => 'unknown');
        const prepared = await ports.withWork(reader, context.work, limits.candidate, async (native) => {
          const prepared = await exact.prepare(
            dependencies,
            {
              realmId: realm.realm,
              candidates: candidates.map((candidate) => ({
                threadId: candidate.thread,
                openingPostId: candidate.opening,
                subjectId: candidate.terminal!,
              })),
            },
            native,
          );
          return prepared.finish();
        });
        return prepared.map((result) =>
          result.state === 'positive' ? 'discussed' : result.state === 'absent' ? 'not_published' : result.state,
        );
      },
      async subject(subject, dependency, context) {
        if (!parents.has(dependency)) return { state: 'unknown' };
        try {
          const value = await ports.withWork(reader, context.work, limits.subject, (native) =>
            exact.subject(dependencies, subject, native),
          );
          return value ? { state: 'readable', terminal: subject } : { state: 'withheld' };
        } catch (error) {
          const state = ports.failure(error);
          if (state) return { state: state === 'concealed' ? 'withheld' : 'unknown' };
          throw error;
        }
      },
    };

    return ports.source(input.pool, disclosure);
  }
}
