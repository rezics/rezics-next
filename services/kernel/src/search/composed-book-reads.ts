import { advanceNativePublicFilterPreparation } from './native-bindings.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Admission, AdmissionYield, JobContext } from '../http/admission.ts';
import type {
  NativeBookPreparation,
  NativePublicFilterPreparation,
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
  PublicFilterNativeSource,
  PublicFilterConsumerContext,
  PublicFilterQueriedObservation,
  PublicFilterSourceBootstrapBinding,
  PublicFilterSourceBinding,
  PublicFilterSource,
} from '../semantic/index.ts';
import { readBookIdentities, type BookIdentityRead } from './composed-book-identities.ts';
import { withPublicFilterCoverageStarts } from './public-filter-coverage-page.ts';

type Population = Extract<PrivacyReductionObservationRequest, { kind: 'population' }>;
type Role = {
  source: PublicFilterNativeSource;
  admit: AdmissionYield;
  population: string;
  request: Population;
  page: string;
};
type Waiting = Role & { answer: PromiseWithResolvers<PrivacyReductionObservation> };
type Capture = {
  binding: PublicFilterSourceBootstrapBinding;
  input: NativeBookPreparation;
  context: PublicFilterConsumerContext;
  admit: AdmissionYield;
  answer: PromiseWithResolvers<NativePublicFilterPreparation | null>;
};
type Child = {
  capture: PromiseWithResolvers<Capture | undefined>;
  requestedCapture?: boolean;
  page?: string;
  closed: boolean;
  planned: PromiseWithResolvers<Waiting | undefined>;
  identities: PromiseWithResolvers<BookIdentityRead | undefined>;
  requestedIdentities?: boolean;
  sealed: PromiseWithResolvers<Waiting | undefined>;
};
const active = new AsyncLocalStorage<Child>();
const catalogue = new AsyncLocalStorage<{ child: Child; yieldPermit: AdmissionYield; admit: AdmissionYield }>();

export function runBookCatalogueRead<T>(admission: Admission, job: JobContext, run: () => Promise<T>) {
  const child = active.getStore();
  return admission.run('normal', job, (yieldPermit) =>
    child ? catalogue.run({ child, yieldPermit, admit: (work) => admission.run('normal', job, work) }, run) : run(),
  );
}

function native(source: PublicFilterSource): source is PublicFilterNativeSource {
  return 'resolvePublicFilterDefinition' in source && typeof source.resolvePublicFilterDefinition === 'function';
}

export function restoreComposedBookCut(
  binding: PublicFilterSourceBinding,
  queried: PublicFilterQueriedObservation,
  context: PublicFilterConsumerContext,
) {
  const command = catalogue.getStore();
  if (!command || command.child.closed || command.child.page || queried.snapshot.kind !== 'pit') return;
  return advanceNativePublicFilterPreparation(binding, { pageObservation: queried }, context);
}

export function composedBookCapture(
  binding: PublicFilterSourceBootstrapBinding,
  input: NativeBookPreparation,
  context: PublicFilterConsumerContext,
  charge: (cut: NativePublicFilterPreparation) => void,
) {
  const command = catalogue.getStore();
  if (!command || !native(input.source) || command.child.closed || command.child.requestedCapture || command.child.page)
    return;
  command.child.requestedCapture = true;
  return command.yieldPermit(async () => {
    const answer = Promise.withResolvers<NativePublicFilterPreparation | null>();
    command.child.capture.resolve({ binding, input, context, answer, admit: command.admit });
    const cut = await answer.promise;
    if (cut) charge(cut);
    return cut;
  });
}

async function beginCuts(waiting: Capture[], check: () => void) {
  const resume = new Map<Capture, () => void>();
  for (const [binding, members] of Map.groupBy(waiting, (member) => member.binding)) {
    for (const peers of Map.groupBy(members, ({ input }) =>
      JSON.stringify([
        input.consumer.physicalTarget,
        input.consumer.incarnation,
        input.definition.source,
        input.meaning.digest,
        input.definition.dependencyKeys,
      ]),
    ).values()) {
      // Identical registrations may race on the same request key. Let the
      // ordinary conflict/recovery path see the preceding cut.
      const groups: Capture[][] = [];
      for (const peer of peers) {
        const group = groups.find((g) =>
          g.every((v) => v.input.definition.readDefinition !== peer.input.definition.readDefinition),
        );
        if (group) group.push(peer);
        else groups.push([peer]);
      }
      for (const group of groups) {
        try {
          check();
          const deadline = Math.min(...group.map((v) => v.context.deadline));
          const result = await group[0]!.admit(() =>
            advanceNativePublicFilterPreparation(binding, { members: group.map((v) => v.input) }, { deadline }),
          );
          if (result && result.length !== group.length) throw new TypeError('Incomplete Book capture');
          group.forEach((v, i) => resume.set(v, () => v.answer.resolve(result?.[i] ?? null)));
        } catch (error) {
          for (const member of group) resume.set(member, () => member.answer.reject(error));
        }
      }
    }
  }
  return resume;
}

/** Yield the worker only after the plan (or sealed tail) owns its native reference.
 * The original Search invocation, meter, cursor and cleanup stay with the child.
 */
export function composedBookObservation(
  source: PublicFilterSource,
  population: string | undefined,
  page: string,
  request: Population,
  charge: (observation: PrivacyReductionObservation) => void,
): Promise<PrivacyReductionObservation> | undefined {
  const command = catalogue.getStore();
  if (!command || command.child.closed || !population || !native(source)) return;
  if (request.start === null) {
    if (command.child.page !== undefined) return;
    command.child.capture.resolve(undefined);
    command.child.page = page;
  } else {
    if (command.child.page !== page) return;
    command.child.identities.resolve(undefined);
  }
  return command.yieldPermit(async () => {
    const answer = Promise.withResolvers<PrivacyReductionObservation>();
    const stage = request.start === null ? command.child.planned : command.child.sealed;
    stage.resolve({ source, population, page, request, answer, admit: command.admit });
    // Account the actual role even if reacquiring the HTTP permit fails.
    const observation = await answer.promise;
    charge(observation);
    return observation;
  });
}

export function composedBookIdentities(
  source: PublicFilterSource,
  request: BookIdentityRead['request'],
  charge: BookIdentityRead['charge'],
) {
  const command = catalogue.getStore();
  if (
    !command?.child.page ||
    command.child.closed ||
    command.child.requestedIdentities ||
    !source.readPublicFilterSubjectIdentities
  )
    return;
  command.child.requestedIdentities = true;
  return command.yieldPermit(() => {
    const answer = Promise.withResolvers<Awaited<BookIdentityRead['answer']['promise']>>();
    command.child.identities.resolve({ source, request, charge, answer, admit: command.admit });
    return answer.promise;
  });
}

// Four active commands may use the underlying pools. A parked plan or tail
// occupies no worker and holds no checkout.
async function bounded<T>(items: readonly T[], work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      await work(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
}

async function readRole(waiting: Waiting[], check: () => void) {
  const resume = new Map<Waiting, () => void>();
  for (const [source, members] of Map.groupBy(waiting, (member) => member.source)) {
    // This selects potential peers only. Source compares the complete controls
    // and the reference, physical binding and window of every submitted plan.
    const groups = Map.groupBy(members, ({ population, request: { queried } }) =>
      JSON.stringify([
        population,
        queried.consumer.physicalTarget,
        queried.consumer.incarnation,
        queried.consumer.meaningDigest,
      ]),
    );
    for (const group of groups.values()) {
      try {
        check();
        const starts = group.flatMap(({ request, page }) =>
          request.start === null ? [{ context: request.context, id: page }] : [],
        );
        const observations = await group[0]!.admit(() =>
          withPublicFilterCoverageStarts(starts, () =>
            source.readPrivacyReductionHeads({ kind: 'page', members: group.map(({ request }) => request) }),
          ),
        );
        if (observations.length !== group.length) throw new TypeError('Incomplete Book population response');
        group.forEach((member, index) => resume.set(member, () => member.answer.resolve(observations[index]!)));
      } catch (error) {
        for (const member of group) resume.set(member, () => member.answer.reject(error));
      }
    }
  }
  return resume;
}

/** Run admission, execution and release as bounded phases. Ordinary reads and
 * children refused before a role settle their own command without joining it.
 */
export async function runComposedPageReads<T>(
  reads: readonly T[],
  execute: (read: T, index: number) => Promise<void>,
  check: () => void,
): Promise<void> {
  const children: Child[] = reads.map(() => ({
    closed: false,
    capture: Promise.withResolvers<Capture | undefined>(),
    planned: Promise.withResolvers<Waiting | undefined>(),
    identities: Promise.withResolvers<BookIdentityRead | undefined>(),
    sealed: Promise.withResolvers<Waiting | undefined>(),
  }));
  const done: Promise<void>[] = [];
  const failures: { error: unknown }[] = [];
  await bounded(children, async (child, index) => {
    done[index] = active.run(child, async () => {
      try {
        check();
        await execute(reads[index]!, index);
      } catch (error) {
        failures[index] = { error };
      } finally {
        child.closed = true;
        child.capture.resolve(undefined);
        child.planned.resolve(undefined);
        child.identities.resolve(undefined);
        child.sealed.resolve(undefined);
      }
    });
    await child.capture.promise;
  });
  const captures = await Promise.all(children.map((child) => child.capture.promise));
  const cuts = await beginCuts(
    captures.filter((c) => c !== undefined),
    check,
  );
  await bounded(children, async (child, index) => {
    const capture = captures[index];
    if (capture) cuts.get(capture)!();
    await child.planned.promise;
  });

  const plans = await Promise.all(children.map((child) => child.planned.promise));
  const start = await readRole(
    plans.filter((plan) => plan !== undefined),
    check,
  );
  await bounded(children, async (child, index) => {
    const plan = plans[index];
    if (plan) start.get(plan)!();
    await child.identities.promise;
  });
  const identities = await Promise.all(children.map((child) => child.identities.promise));
  const results = await readBookIdentities(
    identities.filter((read) => read !== undefined),
    check,
  );
  await bounded(children, async (child, index) => {
    const read = identities[index];
    if (read) results.get(read)!();
    await child.sealed.promise;
  });

  const tails = await Promise.all(children.map((child) => child.sealed.promise));
  const final = await readRole(
    tails.filter((tail) => tail !== undefined),
    check,
  );
  await bounded(children, async (_, index) => {
    const tail = tails[index];
    if (tail) final.get(tail)!();
    await done[index];
  });
  check();
  const failure = failures.find((entry) => entry !== undefined);
  if (failure) throw failure.error;
}
