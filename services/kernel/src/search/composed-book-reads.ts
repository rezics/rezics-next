import {
  bindingSteps,
  withBookBindingSteps,
  type BindingOffer,
  type BindingStep,
} from '../request/book-binding-steps.ts';
import { advanceNativePublicFilterPreparation } from './native-bindings.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Admission, AdmissionYield, JobContext } from '../http/request.ts';
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
import { readPageControls, type ControlRow, type PageControl } from './book-page-controls.ts';
import { readBookIdentities, type BookIdentityRead } from './composed-book-identities.ts';
import { readBookSummaries, type BookSummaryRead } from './composed-book-summaries.ts';
import {
  readBookCandidates,
  readBookFigures,
  type BookCandidateRead,
  type BookFigureRead,
} from './composed-book-candidates.ts';
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
// A child can skip a phase (for example, a retained window needs no engine).
// Park at the next role it actually requests. Only the first window joins
// control batches; later rounds follow the original single-page path.
function phase<T>(run: (waiting: T[], check: () => void) => Promise<Map<T, () => void>>) {
  const waiting = new WeakMap<Child, T>();
  return {
    offer(child: Child, request: T) {
      waiting.set(child, request);
      child.next.resolve();
    },
    async settle(children: Child[], check: () => void) {
      const requests = children.map((child) => waiting.get(child)!);
      const replies = await run(requests, check);
      return (index: number) => replies.get(requests[index]!)!();
    },
  };
}

type NativeRole<Input, Result> = Input & { admit: AdmissionYield; answer: PromiseWithResolvers<Result> };
function nativePhase<Input, Result>(
  read: (
    requests: NativeRole<Input, Result>[],
    check: () => void,
  ) => Promise<Map<NativeRole<Input, Result>, () => void>>,
) {
  const stage = phase(read);
  return {
    stage,
    offer(input: Input) {
      const command = catalogue.getStore();
      if (!command || !enter(command.child, stage)) return;
      return command.yieldPermit(() => {
        const answer = Promise.withResolvers<Result>();
        stage.offer(command.child, { ...input, answer, admit: command.admit });
        return answer.promise;
      });
    },
  };
}

type CurrentCheck = { owner: object; expected: string; read: () => Promise<void> };
async function readCurrent(requests: NativeRole<CurrentCheck, void>[], check: () => void) {
  const replies = new Map<(typeof requests)[number], () => void>();
  for (const members of Map.groupBy(requests, (entry) => entry.owner).values()) {
    for (const peers of Map.groupBy(members, (entry) => entry.expected).values()) {
      try {
        check();
        await peers[0]!.admit(peers[0]!.read);
        for (const peer of peers) replies.set(peer, () => peer.answer.resolve());
      } catch (error) {
        for (const peer of peers) replies.set(peer, () => peer.answer.reject(error));
      }
    }
  }
  return replies;
}

type InputOf<T> = Omit<T, 'admit' | 'answer'>;
export const composedBookCandidates = (input: InputOf<BookCandidateRead>) => bookReadStages().candidates.offer(input);
export const composedBookFigures = (input: InputOf<BookFigureRead>) => bookReadStages().figures.offer(input);
export const composedBookSummaries = (input: InputOf<BookSummaryRead>) => bookReadStages().summaries.offer(input);
export function composedBookCurrent(
  role: 'aliasCurrent' | 'releaseCurrent',
  owner: object,
  expected: string,
  read: () => Promise<void>,
) {
  return bookReadStages()[role].offer({ owner, expected, read });
}

async function readBindings(waiting: NativeRole<BindingOffer, unknown>[], check: () => void) {
  const replies = new Map<(typeof waiting)[number], () => void>();
  for (const members of Map.groupBy(waiting, (v) => v.owner).values()) {
    for (const peers of Map.groupBy(members, (v) => v.cohort).values()) {
      const groups: (typeof peers)[] = [];
      for (const peer of peers) {
        const group = groups.find((g) => g.every((v) => v.key !== peer.key));
        if (group) group.push(peer);
        else groups.push([peer]);
      }
      for (const group of groups) {
        try {
          check();
          const first = group.reduce((a, b) => (a.deadline <= b.deadline ? a : b));
          const rows = await first.admit(() =>
            first.read(
              group.map((v) => v.input),
              first.deadline,
            ),
          );
          if (rows.length !== group.length) throw new TypeError('Incomplete Book binding');
          group.forEach((v, i) => replies.set(v, () => v.answer.resolve(rows[i])));
        } catch (error) {
          for (const v of group) replies.set(v, () => v.answer.reject(error));
        }
      }
    }
  }
  return replies;
}

function createBookReadStages() {
  const candidates = nativePhase<InputOf<BookCandidateRead>, Awaited<BookCandidateRead['answer']['promise']>>(
    readBookCandidates,
  );
  const figures = nativePhase<InputOf<BookFigureRead>, Awaited<BookFigureRead['answer']['promise']>>(readBookFigures);
  const summaries = nativePhase<InputOf<BookSummaryRead>, Awaited<BookSummaryRead['answer']['promise']>>(
    readBookSummaries,
  );
  const aliasCurrent = nativePhase<CurrentCheck, void>(readCurrent);
  const releaseCurrent = nativePhase<CurrentCheck, void>(readCurrent);
  const bindingStages = Object.fromEntries(bindingSteps.map((key) => [key, nativePhase(readBindings)])) as Record<
    BindingStep,
    ReturnType<typeof nativePhase<BindingOffer, unknown>>
  >;

  const controls = {
    previousWindow: phase(readPageControls),
    claim: phase(readPageControls),
    savePit: phase(readPageControls),
    transfer: phase(readPageControls),
    load: phase(readPageControls),
    saveWindow: phase(readPageControls),
    plan: phase(readPageControls),
    reserve: phase(readPageControls),
    dispatch: phase(readPageControls),
    complete: phase(readPageControls),
    consume: phase(readPageControls),
    seal: phase(readPageControls),
  };
  const cuts = phase(beginCuts);
  const starts = phase(readRole);
  const identities = phase(readBookIdentities);
  const finals = phase(readRole);
  const phases = [
    bindingStages.definitions.stage,
    bindingStages.registration.stage,
    cuts,
    controls.claim,
    bindingStages.unopened.stage,
    bindingStages.pitOwner.stage,
    bindingStages.beforePit.stage,
    bindingStages.afterPit.stage,
    bindingStages.retain.stage,
    controls.savePit,
    bindingStages.adopt.stage,
    controls.transfer,
    bindingStages.reference.stage,
    bindingStages.restore.stage,
    controls.load,
    controls.previousWindow,
    controls.plan,
    starts,
    controls.reserve,
    controls.dispatch,
    bindingStages.successor.stage,
    identities,
    controls.complete,
    controls.saveWindow,
    candidates.stage,
    controls.consume,
    figures.stage,
    summaries.stage,
    aliasCurrent.stage,
    controls.seal,
    finals,
    bindingStages.release.stage,
    releaseCurrent.stage,
  ];
  return {
    candidates,
    figures,
    summaries,
    aliasCurrent,
    releaseCurrent,
    bindingStages,
    controls,
    cuts,
    starts,
    identities,
    finals,
    phases,
  };
}

let nativeBookStages: ReturnType<typeof createBookReadStages> | undefined;
function bookReadStages() {
  return (nativeBookStages ??= createBookReadStages());
}

type Child = {
  next: PromiseWithResolvers<void>;
  position: number;
  page?: string;
};
function enter(child: Child, stage: object) {
  const position = bookReadStages().phases.findIndex((item) => item === stage);
  if (position <= child.position) return false;
  child.position = position;
  return true;
}
const active = new AsyncLocalStorage<Child>();
const catalogue = new AsyncLocalStorage<{ child: Child; yieldPermit: AdmissionYield; admit: AdmissionYield }>();

export function runBookCatalogueRead<T>(admission: Admission, job: JobContext, run: () => Promise<T>) {
  const child = active.getStore();
  return admission.run('normal', job, (yieldPermit) =>
    child
      ? catalogue.run({ child, yieldPermit, admit: (work) => admission.run('normal', job, work) }, () =>
          withBookBindingSteps((step, offer) => bookReadStages().bindingStages[step].offer(offer), run),
        )
      : run(),
  );
}

function native(source: PublicFilterSource): source is PublicFilterNativeSource {
  return 'resolvePublicFilterDefinition' in source && typeof source.resolvePublicFilterDefinition === 'function';
}

export function restoreBookPageCut(
  binding: PublicFilterSourceBinding,
  queried: PublicFilterQueriedObservation,
  context: PublicFilterConsumerContext,
) {
  const command = catalogue.getStore();
  if (
    queried.snapshot.kind !== 'pit' ||
    (command && (command.child.position >= bookReadStages().phases.length || command.child.page))
  )
    return;
  // The native owner identifies the published Book cut. Standalone pages
  // restore it too, then verify current coverage at START before dispatch.
  return advanceNativePublicFilterPreparation(binding, { pageObservation: queried }, context);
}

export function composedBookCapture(
  binding: PublicFilterSourceBootstrapBinding,
  input: NativeBookPreparation,
  context: PublicFilterConsumerContext,
  charge: (cut: NativePublicFilterPreparation) => void,
) {
  const command = catalogue.getStore();
  if (!command || !native(input.source) || command.child.page) return;
  const { cuts } = bookReadStages();
  if (!enter(command.child, cuts)) return;
  return command.yieldPermit(async () => {
    const answer = Promise.withResolvers<NativePublicFilterPreparation | null>();
    cuts.offer(command.child, { binding, input, context, answer, admit: command.admit });
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

/** Use the bounded Source verifier once the page owns its native reference.
 * Composed reads yield their permit while the role is shared across children.
 */
export function bookPageObservation(
  source: PublicFilterSource,
  population: string | undefined,
  page: string,
  request: Population,
  charge: (observation: PrivacyReductionObservation) => void,
): Promise<PrivacyReductionObservation> | undefined {
  const command = catalogue.getStore();
  if (!population || !native(source)) return;
  if (!command) {
    // Only the sealed standalone page uses the bounded role.
    if (request.start === null) return;
    return source.readPrivacyReductionHeads({ kind: 'page', members: [request] }).then(([observation]) => {
      if (!observation) throw new TypeError('Incomplete Book population response');
      charge(observation);
      return observation;
    });
  }
  const { starts, finals } = bookReadStages();
  const stage = request.start === null ? starts : finals;
  if ((command.child.page !== undefined && command.child.page !== page) || !enter(command.child, stage)) return;
  command.child.page = page;
  return command.yieldPermit(async () => {
    const answer = Promise.withResolvers<PrivacyReductionObservation>();
    stage.offer(command.child, { source, population, page, request, answer, admit: command.admit });
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
  if (!command?.child.page || !source.readPublicFilterSubjectIdentities) return;
  const { identities } = bookReadStages();
  if (!enter(command.child, identities)) return;
  return command.yieldPermit(() => {
    const answer = Promise.withResolvers<Awaited<BookIdentityRead['answer']['promise']>>();
    identities.offer(command.child, { source, request, charge, answer, admit: command.admit });
    return answer.promise;
  });
}

export function composedBookControl(input: PageControl) {
  const command = catalogue.getStore();
  if (!command) return;
  const stage = bookReadStages().controls[input.phase];
  if ((command.child.page !== undefined && command.child.page !== input.page) || !enter(command.child, stage)) return;
  if (input.page !== null) command.child.page = input.page;
  return command.yieldPermit(() => {
    const answer = Promise.withResolvers<ControlRow | undefined>();
    stage.offer(command.child, { ...input, admit: command.admit, answer });
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
  const { phases } = bookReadStages();
  const children: Child[] = reads.map(() => ({ next: Promise.withResolvers<void>(), position: -1 }));
  const failures: { error: unknown }[] = [];
  await bounded(children, async (child, index) => {
    void active.run(child, async () => {
      try {
        check();
        await execute(reads[index]!, index);
      } catch (error) {
        failures[index] = { error };
      } finally {
        child.position = phases.length;
        child.next.resolve();
      }
    });
    await child.next.promise;
  });
  for (const [position, stage] of phases.entries()) {
    const waiting = children.filter((child) => child.position === position);
    const resume = await stage.settle(waiting, check);
    await bounded(waiting, async (child, index) => {
      child.next = Promise.withResolvers<void>();
      resume(index);
      await child.next.promise;
    });
  }
  check();
  const failure = failures.find((entry) => entry !== undefined);
  if (failure) throw failure.error;
}
