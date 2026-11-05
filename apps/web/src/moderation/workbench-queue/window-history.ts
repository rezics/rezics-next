import type { QueryClient } from '@tanstack/react-query';
import type { PrivateReaderRead } from '../private-reader-lifetime';
import { parseWorkbenchCaseSearch, type WorkbenchCaseSearch } from '../workbench-case/read-model';
import type { WorkbenchRead } from './read';
import {
  workbenchReadKey,
  workbenchScope,
  workbenchSearch,
  type WorkbenchQueueKind,
  type WorkbenchSearch,
} from './scope';

export const WORKBENCH_PRIOR_WINDOW_LIMIT = 8;
const WORKBENCH_WINDOW_LIMIT = WORKBENCH_PRIOR_WINDOW_LIMIT + 1;

export type WorkbenchWindowMove = 'previous' | 'next' | 'refresh' | 'first';
export type WorkbenchWindowRetry = WorkbenchWindowMove | 'current';
type WorkbenchWindowMode = 'queue' | 'history' | 'case' | 'failed' | 'stale';
type WorkbenchAddress = string | null;
type WorkbenchQueueKindWindow = Extract<WorkbenchQueueKind, 'reports' | 'resolved'>;

type QueueIdentity = {
  boardId: string;
  realm?: string;
  queue: WorkbenchQueueKindWindow;
  targetKind: WorkbenchSearch['targetKind'];
  order: WorkbenchSearch['order'];
  directory?: true;
  directoryCursor?: string;
  directoryRealm?: string;
};

type ReaderFence = { source: string; revision: number; locale: string };
type PendingTransition =
  | { kind: 'move'; move: WorkbenchWindowRetry }
  | { kind: 'history' }
  | { kind: 'case-open' }
  | { kind: 'case-return' };

type FocusTicket = {
  kind: 'window' | 'case-return' | 'appeal-return';
  source: HTMLElement;
  eligible: () => boolean;
  cancel: () => void;
};

type WindowState = {
  visitId: string;
  identity: QueueIdentity;
  fence: ReaderFence;
  addresses: WorkbenchAddress[];
  index: number;
  mode: WorkbenchWindowMode;
  pending?: PendingTransition | undefined;
  transitionApproved: boolean;
  reportId?: string | undefined;
  focus?: FocusTicket | undefined;
};

type AppealVisit = {
  visitId: string;
  appealId: string;
  queueSearch: WorkbenchSearch;
  fence: ReaderFence;
  generation: string;
  mode: 'queue' | 'detail';
  pending?: 'open' | 'return';
  transitionApproved: boolean;
  focus?: FocusTicket;
};

export type WorkbenchWindowView = {
  previous: boolean;
  refresh: boolean;
  first: boolean;
  retry?: WorkbenchWindowRetry;
};

export type WorkbenchQueuePage = PrivateReaderRead & {
  state: 'ready' | 'denied' | 'unavailable' | 'stale';
  locale?: string;
  next: string | null;
};

export type WorkbenchPrivateVisit = PrivateReaderRead;

export type WorkbenchNavigationTarget = { pathname: string; search: Record<string, unknown> };

type FocusResult =
  | { kind: 'window' }
  | { kind: 'case-return'; reportId?: string }
  | { kind: 'appeal-return'; appealId: string };

const histories = new WeakMap<QueryClient, WorkbenchQueueWindowHistory>();

function identityOf(search: WorkbenchSearch): QueueIdentity | null {
  const scope = workbenchScope(search);
  if (scope.kind !== 'board' || (search.queue !== 'reports' && search.queue !== 'resolved')) return null;
  return {
    boardId: scope.boardId,
    ...(scope.realmId ? { realm: scope.realmId } : {}),
    queue: search.queue,
    targetKind: search.targetKind,
    order: search.order,
    ...(search.directory ? { directory: true } : {}),
    ...(search.directoryCursor ? { directoryCursor: search.directoryCursor } : {}),
    ...(search.directoryRealm ? { directoryRealm: search.directoryRealm } : {}),
  };
}

function sameIdentity(a: QueueIdentity, b: QueueIdentity): boolean {
  return (
    a.boardId === b.boardId &&
    a.realm === b.realm &&
    a.queue === b.queue &&
    a.targetKind === b.targetKind &&
    a.order === b.order &&
    a.directory === b.directory &&
    a.directoryCursor === b.directoryCursor &&
    a.directoryRealm === b.directoryRealm
  );
}

function fenceOf(page: WorkbenchPrivateVisit, locale: string): ReaderFence | null {
  const binding = page.readerBinding;
  if (!binding || binding.retired || !page.readerOrigin) return null;
  return { source: binding.source, revision: binding.revision, locale };
}

function sameFence(a: ReaderFence, b: ReaderFence): boolean {
  return a.source === b.source && a.revision === b.revision && a.locale === b.locale;
}

function cursorOf(search: WorkbenchSearch): WorkbenchAddress {
  return search.cursor ?? null;
}

function queueSearchMatchesCase(identity: QueueIdentity, address: WorkbenchAddress, search: WorkbenchCaseSearch) {
  return (
    search.boardId === identity.boardId &&
    search.realm === identity.realm &&
    search.queue === identity.queue &&
    search.status === (identity.queue === 'resolved' ? 'resolved' : 'pending') &&
    search.targetKind === identity.targetKind &&
    search.order === identity.order &&
    (search.cursor ?? null) === address &&
    search.directory === identity.directory &&
    search.directoryCursor === identity.directoryCursor &&
    search.directoryRealm === identity.directoryRealm
  );
}

function workbenchTarget(target: WorkbenchNavigationTarget): WorkbenchSearch | null {
  if (!target.pathname.endsWith('/moderation/workbench') && target.pathname !== '/moderation/workbench') return null;
  return workbenchSearch(target.search);
}

function caseIdFromPath(pathname: string): string | null {
  const marker = '/moderation/cases/';
  const start = pathname.lastIndexOf(marker);
  if (start < 0) return null;
  const value = pathname.slice(start + marker.length);
  if (!value || value.includes('/')) return null;
  return value;
}

function caseSearchMatchesQueue(identity: QueueIdentity, address: WorkbenchAddress, search: WorkbenchCaseSearch) {
  return (
    search.boardId === identity.boardId &&
    search.realm === identity.realm &&
    search.queue === identity.queue &&
    search.status === (identity.queue === 'resolved' ? 'resolved' : 'pending') &&
    search.targetKind === identity.targetKind &&
    search.order === identity.order &&
    (search.cursor ?? null) === address &&
    search.directory === identity.directory &&
    search.directoryCursor === identity.directoryCursor &&
    search.directoryRealm === identity.directoryRealm
  );
}

function caseMatchesQueue(
  identity: QueueIdentity,
  address: WorkbenchAddress,
  target: WorkbenchNavigationTarget,
  expectedReportId: string,
) {
  const routeId = caseIdFromPath(target.pathname);
  const search = parseWorkbenchCaseSearch(target.search);
  return (routeId === encodeURIComponent(expectedReportId) || routeId === expectedReportId) &&
    search &&
    caseSearchMatchesQueue(identity, address, search)
    ? expectedReportId
    : null;
}

function queueAddressMatches(identity: QueueIdentity, address: WorkbenchAddress, target: WorkbenchSearch) {
  const targetIdentity = identityOf(target);
  return (
    targetIdentity !== null && sameIdentity(identity, targetIdentity) && cursorOf(target) === address && !target.case
  );
}

function isHistorySearch(search: WorkbenchSearch) {
  return search.history === true;
}

function focusTicket(
  kind: FocusTicket['kind'],
  source: HTMLElement | undefined,
  keyboard: boolean,
  keepForCaseReturn = false,
  preserveKeyboardPath = false,
): FocusTicket | undefined {
  if (!source || (keyboard && source.ownerDocument.activeElement !== source) || (!keyboard && !keepForCaseReturn))
    return undefined;
  const document = source.ownerDocument;
  let eligible = true;
  const ticket: FocusTicket = {
    kind,
    source,
    eligible: () => eligible,
    cancel() {
      eligible = false;
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin, true);
    },
  };
  const cancel = () => ticket.cancel();
  const keydown = (event: KeyboardEvent) => {
    if (!preserveKeyboardPath && event.key === 'Tab') cancel();
  };
  const focusin = (event: FocusEvent) => {
    if (!preserveKeyboardPath && event.target !== source && event.target !== document.body) cancel();
  };
  document.addEventListener('pointerdown', cancel, true);
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('focusin', focusin, true);
  return ticket;
}

function allowedCaseReturnSearch(state: WindowState, raw: Record<string, unknown>) {
  const search = workbenchSearch(raw);
  const address = state.addresses[state.index];
  return address !== undefined && queueAddressMatches(state.identity, address, search) && !search.history;
}

function appealQueueSearch(search: WorkbenchSearch) {
  return workbenchSearch({ ...search, case: '' });
}

function sameAppealQueue(a: WorkbenchSearch, b: WorkbenchSearch) {
  return (
    a.queue === 'appeals' &&
    b.queue === 'appeals' &&
    workbenchReadKey(appealQueueSearch(a)) === workbenchReadKey(appealQueueSearch(b))
  );
}

/** One tab-local coordinate chain. Queue rows and action advice never enter this store. */
export class WorkbenchQueueWindowHistory {
  private state: WindowState | undefined;
  private appealVisit: AppealVisit | undefined;
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.revision;

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private clear() {
    if (!this.state) return;
    this.state?.focus?.cancel();
    this.state = undefined;
    this.publish();
  }

  private clearAppeal() {
    if (!this.appealVisit) return;
    this.appealVisit.focus?.cancel();
    this.appealVisit = undefined;
    this.publish();
  }

  view(
    visitId: string | undefined,
    search: WorkbenchSearch,
    pageState: WorkbenchQueuePage['state'],
  ): WorkbenchWindowView {
    const identity = identityOf(search);
    const state = this.state;
    const matches = Boolean(
      visitId &&
      identity &&
      state &&
      state.visitId === visitId &&
      sameIdentity(state.identity, identity) &&
      !search.history &&
      !search.case,
    );
    const active = matches && state?.mode === 'queue' && state.index >= 0 && !state.pending;
    const current = active ? state!.addresses[state!.index] : null;
    const pendingMove =
      matches && state?.mode === 'failed' && state.pending?.kind === 'move' ? state.pending.move : undefined;
    const isFirst = cursorOf(search) === null;
    const firstPending = Boolean(matches && state?.pending?.kind === 'move' && state.pending.move === 'first');
    return {
      previous: Boolean(active && state!.index > 0 && pageState === 'ready' && current === cursorOf(search)),
      refresh: Boolean(active && pageState === 'ready' && current === cursorOf(search)),
      first: Boolean(
        identity &&
        pageState !== 'denied' &&
        (pageState === 'stale' || !isFirst || Boolean(active && state!.index > 0) || firstPending),
      ),
      ...(pendingMove ? { retry: pendingMove } : matches && state?.mode === 'failed' ? { retry: 'current' } : {}),
    };
  }

  beginMove(input: {
    visitId: string | undefined;
    search: WorkbenchSearch;
    fence: ReaderFence | null;
    move: WorkbenchWindowMove;
    source?: HTMLElement;
    keyboard: boolean;
  }) {
    const identity = identityOf(input.search);
    const state = this.state;
    if (!identity || !input.visitId || !input.fence || !state || state.visitId !== input.visitId) return false;
    if (!sameIdentity(state.identity, identity) || !sameFence(state.fence, input.fence)) return false;
    if (state.mode !== 'queue' && !(input.move === 'first' && (state.mode === 'stale' || state.mode === 'failed')))
      return false;
    if (state.pending && input.move !== 'first') return false;
    if (input.move === 'previous' && state.index <= 0) return false;
    if (input.move === 'next' && (state.index < 0 || cursorOf(input.search) !== state.addresses[state.index]))
      return false;
    if (input.move === 'refresh' && (state.index < 0 || cursorOf(input.search) !== state.addresses[state.index]))
      return false;
    state.pending = { kind: 'move', move: input.move };
    state.transitionApproved = false;
    state.focus?.cancel();
    state.focus = focusTicket('window', input.source, input.keyboard);
    this.publish();
    return true;
  }

  previousAddress(visitId: string | undefined, search: WorkbenchSearch): WorkbenchAddress | undefined {
    const identity = identityOf(search);
    const state = this.state;
    if (
      !identity ||
      !visitId ||
      !state ||
      state.visitId !== visitId ||
      state.mode !== 'queue' ||
      state.index <= 0 ||
      !sameIdentity(state.identity, identity) ||
      state.addresses[state.index] !== cursorOf(search)
    )
      return undefined;
    return state.addresses[state.index - 1];
  }

  beginRetry(input: {
    visitId: string | undefined;
    search: WorkbenchSearch;
    fence: ReaderFence | null;
    source?: HTMLElement;
    keyboard: boolean;
  }) {
    const identity = identityOf(input.search);
    const state = this.state;
    if (!identity || !input.visitId || !input.fence || !state || state.visitId !== input.visitId) return false;
    if (!sameIdentity(state.identity, identity) || !sameFence(state.fence, input.fence) || state.mode !== 'failed')
      return false;
    if (!state.pending) state.pending = { kind: 'move', move: 'current' };
    state.focus?.cancel();
    state.focus = focusTicket('window', input.source, input.keyboard);
    this.publish();
    return true;
  }

  beginHistory(visitId: string | undefined, current: WorkbenchSearch, next: WorkbenchSearch) {
    const identity = identityOf(current);
    const nextIdentity = identityOf(next);
    const state = this.state;
    if (
      !visitId ||
      !identity ||
      !nextIdentity ||
      !state ||
      state.visitId !== visitId ||
      (state.mode !== 'queue' && state.mode !== 'history') ||
      !sameIdentity(state.identity, identity) ||
      !sameIdentity(identity, nextIdentity) ||
      cursorOf(current) !== cursorOf(next) ||
      (!isHistorySearch(next) && !next.historyReturn)
    ) {
      this.clearForVisit(visitId);
      return false;
    }
    state.pending = { kind: 'history' };
    state.transitionApproved = false;
    this.publish();
    return true;
  }

  beginCaseDeparture(input: {
    visitId: string | undefined;
    search: WorkbenchSearch;
    fence: ReaderFence | null;
    reportId: string;
  }) {
    const identity = identityOf(input.search);
    const state = this.state;
    if (
      !identity ||
      !input.visitId ||
      !input.fence ||
      !state ||
      state.visitId !== input.visitId ||
      state.mode !== 'queue' ||
      state.index < 0 ||
      !sameIdentity(state.identity, identity) ||
      !sameFence(state.fence, input.fence) ||
      state.addresses[state.index] !== cursorOf(input.search)
    ) {
      this.clearForVisit(input.visitId);
      return false;
    }
    state.pending = { kind: 'case-open' };
    state.reportId = input.reportId;
    state.transitionApproved = false;
    this.publish();
    return true;
  }

  admitCase(input: {
    visitId: string | undefined;
    page: WorkbenchPrivateVisit;
    search: WorkbenchCaseSearch;
    reportId: string;
    locale: string;
  }) {
    const state = this.state;
    const fence = fenceOf(input.page, input.locale);
    const address = state?.addresses[state.index];
    if (
      input.visitId &&
      fence &&
      state &&
      state.visitId === input.visitId &&
      state.mode === 'case' &&
      state.reportId === input.reportId &&
      address !== undefined &&
      sameFence(state.fence, fence) &&
      caseSearchMatchesQueue(state.identity, address, input.search)
    )
      return true;
    if (
      !input.visitId ||
      !fence ||
      !state ||
      !state.transitionApproved ||
      state.pending?.kind !== 'case-open' ||
      state.reportId !== input.reportId ||
      address === undefined ||
      !sameFence(state.fence, fence) ||
      !caseSearchMatchesQueue(state.identity, address, input.search)
    ) {
      this.clear();
      return false;
    }
    state.visitId = input.visitId;
    state.mode = 'case';
    state.pending = undefined;
    state.transitionApproved = false;
    this.publish();
    return true;
  }

  beginCaseReturn(input: {
    visitId: string | undefined;
    page: WorkbenchPrivateVisit;
    search: WorkbenchCaseSearch;
    reportId: string;
    locale: string;
    source?: HTMLElement;
  }) {
    const state = this.state;
    const fence = fenceOf(input.page, input.locale);
    const address = state?.addresses[state.index];
    if (
      !input.visitId ||
      !fence ||
      !state ||
      state.visitId !== input.visitId ||
      state.mode !== 'case' ||
      state.reportId !== input.reportId ||
      address === undefined ||
      !sameFence(state.fence, fence) ||
      !caseSearchMatchesQueue(state.identity, address, input.search)
    ) {
      this.clearForVisit(input.visitId);
      return false;
    }
    state.pending = { kind: 'case-return' };
    state.transitionApproved = false;
    state.focus?.cancel();
    state.focus = focusTicket('case-return', input.source, false, true);
    this.publish();
    return true;
  }

  beginAppealDeparture(input: {
    visitId: string | undefined;
    page: WorkbenchRead;
    search: WorkbenchSearch;
    appealId: string;
    locale: string;
    source?: HTMLElement;
    keyboard: boolean;
  }) {
    const fence = fenceOf(input.page, input.locale);
    if (
      !input.visitId ||
      !fence ||
      input.page.state !== 'ready' ||
      input.search.queue !== 'appeals' ||
      input.search.case ||
      !input.page.cases.some((item) => item.kind === 'appeal' && item.id === input.appealId)
    ) {
      this.clearAppeal();
      return false;
    }
    this.clearAppeal();
    const focus = focusTicket('appeal-return', input.source, input.keyboard, false, true);
    this.appealVisit = {
      visitId: input.visitId,
      appealId: input.appealId,
      queueSearch: appealQueueSearch(input.search),
      fence,
      generation: input.page.generation,
      mode: 'queue',
      pending: 'open',
      transitionApproved: false,
      ...(focus ? { focus } : {}),
    };
    this.publish();
    return true;
  }

  beginAppealReturn(input: {
    visitId: string | undefined;
    page: WorkbenchRead;
    search: WorkbenchSearch;
    appealId: string;
    locale: string;
  }) {
    const state = this.appealVisit;
    const fence = fenceOf(input.page, input.locale);
    if (
      !input.visitId ||
      !fence ||
      !state ||
      state.visitId !== input.visitId ||
      state.mode !== 'detail' ||
      state.appealId !== input.appealId ||
      input.search.queue !== 'appeals' ||
      input.search.case !== input.appealId ||
      input.page.state !== 'ready' ||
      state.generation !== input.page.generation ||
      input.page.selectedAppeal?.id !== input.appealId ||
      !sameAppealQueue(state.queueSearch, input.search) ||
      !sameFence(state.fence, fence)
    ) {
      this.clearAppealForVisit(input.visitId);
      return false;
    }
    state.pending = 'return';
    state.transitionApproved = false;
    this.publish();
    return true;
  }

  /** Admit only the exact selected appeal or the exact captured queue after its native reread. */
  admitAppeal(input: {
    visitId: string | undefined;
    page: WorkbenchRead;
    search: WorkbenchSearch;
    locale: string;
    admitted: boolean;
  }): FocusResult | null {
    const state = this.appealVisit;
    const fence = fenceOf(input.page, input.locale);
    if (!state) return null;
    if (!input.visitId || !input.admitted || !fence || input.page.state !== 'ready') {
      this.clearAppeal();
      return null;
    }
    if (input.search.queue !== 'appeals' || !sameFence(state.fence, fence)) {
      this.clearAppeal();
      return null;
    }
    if (input.search.case) {
      const exactSelection = input.search.case === state.appealId && input.page.selectedAppeal?.id === state.appealId;
      const sameDetail =
        state.mode === 'detail' &&
        state.visitId === input.visitId &&
        state.generation === input.page.generation &&
        exactSelection &&
        sameAppealQueue(state.queueSearch, input.search);
      const openedFromQueue =
        state.mode === 'queue' &&
        state.pending === 'open' &&
        state.transitionApproved &&
        exactSelection &&
        sameAppealQueue(state.queueSearch, input.search);
      if (!sameDetail && !openedFromQueue) {
        this.clearAppeal();
        return null;
      }
      if (openedFromQueue) {
        state.visitId = input.visitId;
        state.mode = 'detail';
        state.generation = input.page.generation;
        delete state.pending;
        state.transitionApproved = false;
        this.publish();
      }
      return null;
    }
    const returnedToQueue =
      state.mode === 'detail' &&
      state.pending === 'return' &&
      state.transitionApproved &&
      sameAppealQueue(state.queueSearch, input.search) &&
      input.page.cases.some((item) => item.kind === 'appeal' && item.id === state.appealId);
    if (!returnedToQueue) {
      this.clearAppeal();
      return null;
    }
    const appealId = state.appealId;
    const focus = state.focus;
    const restoreFocus = focus?.eligible() ?? false;
    this.clearAppeal();
    return restoreFocus ? { kind: 'appeal-return', appealId } : null;
  }

  navigate(
    visitId: string | undefined,
    target: WorkbenchNavigationTarget,
    current: WorkbenchSearch | WorkbenchCaseSearch,
    page: WorkbenchPrivateVisit & { state?: string; next?: string | null },
  ) {
    if (this.appealVisit && this.appealVisit.visitId !== visitId) this.clearAppeal();
    const appeal = this.appealVisit;
    if (appeal && appeal.visitId === visitId) {
      const fence = fenceOf(page, appeal.fence.locale);
      const currentSearch = !('boardId' in current) ? workbenchSearch(current as WorkbenchSearch) : null;
      const next = workbenchTarget(target);
      const exactFence = fence && sameFence(appeal.fence, fence);
      const openAllowed =
        appeal.pending === 'open' &&
        currentSearch &&
        !currentSearch.case &&
        sameAppealQueue(appeal.queueSearch, currentSearch) &&
        next?.case === appeal.appealId &&
        sameAppealQueue(appeal.queueSearch, next);
      const returnAllowed =
        appeal.pending === 'return' &&
        currentSearch?.case === appeal.appealId &&
        sameAppealQueue(appeal.queueSearch, currentSearch) &&
        next &&
        !next.case &&
        sameAppealQueue(appeal.queueSearch, next);
      if (!exactFence || (!openAllowed && !returnAllowed)) {
        this.clearAppeal();
        return false;
      }
      appeal.transitionApproved = true;
      this.publish();
      return true;
    }
    const state = this.state;
    if (!visitId || !state || state.visitId !== visitId || !state.pending) {
      this.clearForVisit(visitId);
      return false;
    }
    const pending = state.pending;
    const fence = fenceOf(page, state.fence.locale);
    const currentIsWorkbench = !('boardId' in current);
    const currentQueue = currentIsWorkbench ? workbenchSearch(current as WorkbenchSearch) : null;
    const currentIdentity = currentQueue ? identityOf(currentQueue) : null;
    const address = state.addresses[state.index];
    let allowed = Boolean(fence && sameFence(state.fence, fence));

    if (allowed && pending.kind === 'move') {
      const next = workbenchTarget(target);
      const identity = next ? identityOf(next) : null;
      allowed = Boolean(next && identity && sameIdentity(state.identity, identity) && !next.history && !next.case);
      if (allowed) {
        if (pending.move === 'next')
          allowed = page.state === 'ready' && !!page.next && page.next.length <= 4096 && next!.cursor === page.next;
        else if (pending.move === 'previous')
          allowed = state.index > 0 && (next!.cursor ?? null) === state.addresses[state.index - 1];
        else if (pending.move === 'first') allowed = next!.cursor === undefined;
        else if (pending.move === 'refresh') allowed = (next!.cursor ?? null) === address;
        else allowed = (next!.cursor ?? null) === (currentQueue ? cursorOf(currentQueue) : null);
      }
    } else if (allowed && pending.kind === 'history') {
      const next = workbenchTarget(target);
      const nextIdentity = next ? identityOf(next) : null;
      const currentAddress = currentQueue ? cursorOf(currentQueue) : null;
      const targetAddress = next ? cursorOf(next) : null;
      allowed = Boolean(
        next &&
        nextIdentity &&
        currentIdentity &&
        sameIdentity(state.identity, nextIdentity) &&
        sameIdentity(state.identity, currentIdentity) &&
        currentAddress === address &&
        targetAddress === address &&
        (isHistorySearch(next) || Boolean(next.historyReturn)),
      );
    } else if (allowed && pending.kind === 'case-open') {
      const caseSearch = parseWorkbenchCaseSearch(target.search);
      const targetReportId =
        address === undefined ? null : caseMatchesQueue(state.identity, address, target, state.reportId ?? '');
      allowed = Boolean(
        targetReportId === state.reportId &&
        caseSearch &&
        caseSearchMatchesQueue(state.identity, address ?? null, caseSearch),
      );
    } else if (allowed && pending.kind === 'case-return') {
      const next = workbenchTarget(target);
      allowed = Boolean(
        next && currentIdentity === null && allowedCaseReturnSearch(state, target.search) && !next.historyReturn,
      );
    }

    if (!allowed) {
      this.clear();
      return false;
    }
    state.transitionApproved = true;
    this.publish();
    return true;
  }

  admitQueue(input: {
    visitId: string | undefined;
    page: WorkbenchQueuePage;
    search: WorkbenchSearch;
    locale: string;
    admitted: boolean;
  }): FocusResult | null {
    const identity = identityOf(input.search);
    const fence = fenceOf(input.page, input.locale);
    if (
      input.page.state === 'denied' ||
      !input.visitId ||
      !identity ||
      !fence ||
      !input.admitted ||
      input.search.case
    ) {
      this.clear();
      return null;
    }

    let state = this.state;
    if (
      !state ||
      !sameIdentity(state.identity, identity) ||
      !sameFence(state.fence, fence) ||
      (state.visitId !== input.visitId && !state.transitionApproved)
    ) {
      state?.focus?.cancel();
      state = {
        visitId: input.visitId,
        identity,
        fence,
        addresses: [],
        index: -1,
        mode: input.search.history
          ? 'history'
          : input.page.state === 'ready'
            ? 'queue'
            : input.page.state === 'stale'
              ? 'stale'
              : 'failed',
        transitionApproved: false,
        ...(input.page.state === 'unavailable' ? { pending: { kind: 'move', move: 'current' } as const } : {}),
      };
      this.state = state;
      if (input.page.state === 'ready' && !input.search.history) this.startChain(state, cursorOf(input.search));
      const focus = this.consumeFocus(state, input.page.state);
      this.publish();
      return focus;
    }

    const pending = state.pending;
    const canApplyTransition = state.visitId === input.visitId || state.transitionApproved;
    if (pending && !canApplyTransition) {
      this.clear();
      return null;
    }
    if (input.search.history) {
      state.visitId = input.visitId;
      state.mode = 'history';
      state.pending = undefined;
      state.transitionApproved = false;
      this.consumeFocus(state, input.page.state);
      this.publish();
      return null;
    }
    if (input.page.state === 'stale') {
      state.visitId = input.visitId;
      state.addresses = [];
      state.index = -1;
      state.mode = 'stale';
      state.pending = undefined;
      state.transitionApproved = false;
      const focus = this.consumeFocus(state, input.page.state);
      this.publish();
      return focus;
    }
    if (input.page.state === 'unavailable') {
      state.visitId = input.visitId;
      state.mode = 'failed';
      state.transitionApproved = false;
      if (pending?.kind === 'history') {
        state.mode = 'history';
        state.pending = undefined;
      } else if (pending?.kind === 'case-open') {
        state.pending = undefined;
        state.addresses = [];
        state.index = -1;
      } else if (pending?.kind === 'case-return') {
        // Keep the captured chain private until this exact queue read succeeds.
      } else if (!pending) {
        state.addresses = [];
        state.index = -1;
        state.pending = { kind: 'move', move: 'current' };
      }
      const focus = this.consumeFocus(state, input.page.state);
      this.publish();
      return focus;
    }

    if (pending?.kind === 'move') {
      switch (pending.move) {
        case 'next': {
          const cursor = cursorOf(input.search);
          if (cursor === null) break;
          const addresses = state.addresses.slice(0, state.index + 1);
          addresses.push(cursor);
          if (addresses.length > WORKBENCH_WINDOW_LIMIT) addresses.shift();
          state.addresses = addresses;
          state.index = addresses.length - 1;
          break;
        }
        case 'previous':
          if (state.index > 0 && cursorOf(input.search) === state.addresses[state.index - 1]) state.index--;
          else this.startChain(state, cursorOf(input.search));
          break;
        case 'first':
          this.startChain(state, null);
          break;
        case 'refresh':
          if (state.index < 0 || state.addresses[state.index] !== cursorOf(input.search))
            this.startChain(state, cursorOf(input.search));
          break;
        case 'current':
          if (state.index < 0) this.startChain(state, cursorOf(input.search));
          break;
      }
    } else if (pending?.kind === 'history' || pending?.kind === 'case-return') {
      if (state.index < 0 || state.addresses[state.index] !== cursorOf(input.search))
        this.startChain(state, cursorOf(input.search));
    } else if (state.mode === 'failed' || state.mode === 'stale' || state.index < 0) {
      this.startChain(state, cursorOf(input.search));
    }

    state.visitId = input.visitId;
    state.mode = 'queue';
    state.pending = undefined;
    state.transitionApproved = false;
    const focus = this.consumeFocus(state, input.page.state);
    if (pending?.kind === 'case-return') state.reportId = undefined;
    this.publish();
    return focus;
  }

  hasFocus() {
    return !!this.state?.focus;
  }

  private startChain(state: WindowState, address: WorkbenchAddress) {
    state.addresses = [address];
    state.index = 0;
  }

  private consumeFocus(state: WindowState, pageState: WorkbenchQueuePage['state']): FocusResult | null {
    const ticket = state.focus;
    if (!ticket) return null;
    state.focus = undefined;
    const document = ticket.source.ownerDocument;
    const active = document.activeElement;
    const stillOwnsHandoff = active === document.body || !active || !active.isConnected;
    const eligible = ticket.eligible();
    ticket.cancel();
    if (!eligible || !stillOwnsHandoff) return null;
    if (ticket.kind === 'case-return' && pageState === 'ready') {
      const reportId = state.reportId;
      return { kind: 'case-return', ...(reportId ? { reportId } : {}) };
    }
    return { kind: 'window' };
  }

  clearForVisit(visitId: string | undefined) {
    if (this.state && (!visitId || this.state.visitId === visitId)) this.clear();
  }

  clearAppealForVisit(visitId: string | undefined) {
    if (this.appealVisit && (!visitId || this.appealVisit.visitId === visitId)) this.clearAppeal();
  }
}

export function workbenchQueueWindowHistory(client: QueryClient) {
  let history = histories.get(client);
  if (!history) {
    history = new WorkbenchQueueWindowHistory();
    histories.set(client, history);
  }
  return history;
}

export function workbenchReaderFence(page: WorkbenchPrivateVisit, locale: string): ReaderFence | null {
  return fenceOf(page, locale);
}

export function isWorkbenchHistoryTransition(current: WorkbenchSearch, next: WorkbenchSearch) {
  const from = identityOf(current);
  const to = identityOf(next);
  return Boolean(
    from &&
    to &&
    sameIdentity(from, to) &&
    cursorOf(current) === cursorOf(next) &&
    (isHistorySearch(next) || (current.history && next.historyReturn)),
  );
}
