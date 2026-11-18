import { AsyncLocalStorage } from 'node:async_hooks';
import type { Admission, AdmissionYield, JobContext } from '../http/admission.ts';
import type {
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
  PublicFilterNativeSource,
  PublicFilterSource,
} from '../semantic/index.ts';
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
type Child = {
  page?: string;
  closed: boolean;
  planned: PromiseWithResolvers<Waiting | undefined>;
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
    command.child.page = page;
  } else if (command.child.page !== page) return;
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
    planned: Promise.withResolvers<Waiting | undefined>(),
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
        child.planned.resolve(undefined);
        child.sealed.resolve(undefined);
      }
    });
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
