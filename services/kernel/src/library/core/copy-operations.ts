import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type {
  CopyMutationOperation,
  CopyMutationOperationInput,
  CopyInventoryOperationInput,
  CopyOperationPlan,
  CopyOperationComponent,
  CopyMutationWork,
} from '../contract/index.ts';

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function maximumCopyBound(...alternatives: readonly Bound[]): Bound {
  const axes = [
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'emptySeeks',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'engineRequests',
  ] as const;
  return declareBound(
    Object.fromEntries(axes.map((axis) => [axis, Math.max(...alternatives.map((bound) => bound[axis]))])) as Bound,
  );
}

function component(kind: string, bound: Bound): CopyOperationComponent {
  return Object.freeze({ kind, bound });
}

export function copyOperationPlan(
  kind: string,
  branch: string,
  input: Record<string, unknown>,
  components: readonly CopyOperationComponent[],
  branches: Readonly<Record<string, Bound>> = {},
): CopyOperationPlan {
  const frozenInput = freezeDeep(structuredClone(input));
  const total = sumBounds(...components.map(({ bound }) => bound));
  return Object.freeze({
    kind,
    branch,
    input: frozenInput,
    components: Object.freeze([...components]),
    branches: Object.freeze({ ...branches }),
    total,
  });
}

function zero(): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });
}
export function copyMutationPlan(
  operation: CopyMutationOperation,
  input: CopyMutationOperationInput,
  subject: string,
  work: CopyMutationWork,
): CopyOperationPlan {
  const {
    prepareRead,
    sourceInitial,
    sourceCurrent,
    lock,
    loan,
    read,
    currentFact,
    mutation,
    trigger,
    privateRead,
    retentionRead,
    retainedReleases,
    restoreSource,
    eventFence,
    terminal,
  } = work;
  const branches: Record<string, Bound> = {};
  if (operation === 'create') {
    branches['fresh.create'] = sumBounds(mutation, trigger, sourceCurrent, eventFence);
  } else if (operation === 'update') {
    branches['fresh.update'] = sumBounds(lock, read, currentFact, loan, mutation, trigger, sourceCurrent, eventFence);
    branches['no-change-patch'] = branches['fresh.update']!;
  } else if (operation === 'delete') {
    branches['fresh.delete'] = sumBounds(lock, read, loan, mutation, trigger, eventFence);
  } else {
    branches['fresh.restore'] = sumBounds(
      prepareRead,
      privateRead,
      retainedReleases,
      restoreSource,
      retentionRead,
      mutation,
      read,
      trigger,
      eventFence,
    );
    branches['stale-expired-occupied'] = sumBounds(prepareRead, privateRead, retentionRead, terminal);
  }
  branches['receipt-replay'] = zero();
  branches['pre-mutation-refusal'] = operation === 'update' || operation === 'delete' ? sumBounds(lock, read) : zero();
  return copyOperationPlan(
    `command.${operation}`,
    'native-attempt',
    {
      operation,
      route: input.route,
      accountId: input.accountId,
      copyId: input.copyId,
      requestKey: input.requestKey,
      commandInput: input.commandInput,
      receiptKeys: input.receiptKeys,
      sourceSubjectId: subject,
    },
    [
      ...work.shared,
      ...(operation === 'update' || operation === 'delete'
        ? [component('command.preparation.copy-snapshot', sumBounds(prepareRead, read))]
        : []),
      ...(operation === 'create' || operation === 'update' ? [component('source.original', sourceInitial)] : []),
      component('command.outcome-branch', maximumCopyBound(...Object.values(branches))),
    ],
    branches,
  );
}

export function copyAccountPlan(route: number, accountId: string, floor: Bound): CopyOperationPlan {
  return copyOperationPlan('account-gate', 'current-owner-floor', { route, accountId }, [
    component('account.floor', floor),
  ]);
}
export function copyReadPlan(
  route: number,
  accountId: string,
  copyId: string,
  work: Readonly<{ read: Bound; transaction: Bound; migration: Bound; partition: Bound; response: Bound }>,
): CopyOperationPlan {
  const branches = { pinned: work.read, preProfile: sumBounds(work.read, work.migration) };
  return copyOperationPlan(
    'read',
    'point',
    { route, accountId, copyId },
    [
      component('owner.read-only-transaction', work.transaction),
      component('owner.partition', work.partition),
      component('copy.read.branch', maximumCopyBound(...Object.values(branches))),
      component('copy.response.serialization', work.response),
    ],
    branches,
  );
}
export function copyPresentationPlan(
  route: number,
  accountId: string,
  copyId: string,
  subjectId: string,
  work: Readonly<{ observation: Bound; pins: Bound; source: Bound; response: Bound }>,
): CopyOperationPlan {
  return copyOperationPlan('read', 'detail-presentation', { route, accountId, copyId, subjectId }, [
    component('copy.detail.two-observations', repeatBound(work.observation, 2)),
    component('copy.original-and-current-profile-pins', work.pins),
    component('copy.original-and-current-source', work.source),
    component('copy.mounted-presentation.serialization', work.response),
  ]);
}
export function copyInventoryPlan(
  input: CopyInventoryOperationInput,
  work: Readonly<{
    readonly: Bound;
    page: Bound;
    sentinel: Bound;
    migration: Bound;
    options: Bound;
    pins: Bound;
    cursor: Bound;
    responses: Bound;
    cursorBytes: number;
  }>,
): CopyOperationPlan {
  const pageBranch = sumBounds(work.readonly, work.page, work.migration);
  const maximumPage = sumBounds(work.readonly, work.page, work.sentinel, repeatBound(work.migration, 2));
  const observation = sumBounds(maximumCopyBound(pageBranch, maximumPage), work.options);
  const branches = {
    firstPage: observation,
    nextPage: observation,
    maximumPageWithSentinel: sumBounds(maximumPage, work.options),
    emptyPage: sumBounds(pageBranch, work.options),
  };
  return copyOperationPlan(
    'inventory',
    'two-filtered-observations',
    { ...input, cursorBytes: work.cursorBytes },
    [
      component('copy.filtered-page.first-and-current', repeatBound(observation, 2)),
      component('copy.distinct-retained-release-pins', work.pins),
      component('copy.cursor.serialization', work.cursor),
      component('copy.inventory.response-and-comparison.serialization', work.responses),
    ],
    branches,
  );
}
