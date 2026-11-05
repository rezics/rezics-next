import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { initials } from '@rezics/ui/avatar-initials';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  parseRealmBanTarget,
  revalidateRealmBanTarget,
  type BanTargetState,
  type RealmBanTarget,
  type ResolveBanTarget,
} from './realm-ban-target';
import type { BanReadState, BanWriteInput, BanWriteResult, RealmBanRow } from './realm-bans';
import { RealmBanLifetime } from './realm-ban-lifetime';
import { RealmBanCurrentControl } from './realm-ban-current-control';
import {
  copyRealmBanEpisode,
  realmBanEpisodeAdvice,
  unavailableRealmBanCurrent,
  type InspectRealmBanCurrent,
} from './realm-ban-current';
import { RealmBanEpisodeView, RealmBanNativeAdvice } from './realm-ban-current-view';
import { useCommunityManagementAdmission } from './community-management';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import type { SelectedRealmMember } from './members/selected-account';

export type RealmBansControlProps = {
  realmId: string;
  /** Default Panel admission; standalone fixtures may omit it. */
  lifetime?: RealmBanLifetime;
  initial?: BanReadState;
  ready: boolean;
  resolve?: ResolveBanTarget;
  inspect?: InspectRealmBanCurrent;
  /** One producer-current selection from the Realm member visit. */
  selectedMember?: SelectedRealmMember;
  read: (cursor?: string) => Promise<BanReadState>;
  write: (input: BanWriteInput) => Promise<BanWriteResult>;
};

/** Native acceptance is distinct from completion of Accounts' membership removal. */
export function RealmBanOutcome({
  result,
  boundaryId,
  historical = false,
}: {
  result: Extract<BanWriteResult, { ok: true }>;
  boundaryId?: string;
  historical?: boolean;
}) {
  const id = useId();
  const accountId = result.action === 'ban' ? result.ban.accountId : result.accountId;
  return (
    <ContentItemFrame
      as="article"
      role="status"
      id={boundaryId}
      tabIndex={boundaryId ? -1 : undefined}
      data-slot="realm-ban-outcome"
      aria-labelledby={`${id}-account`}
      className="min-w-0 space-y-3 wrap-anywhere p-4 text-sm"
    >
      <ContentItemHeading level={3} id={`${id}-account`} className="whitespace-normal font-medium">
        {result.action === 'ban' ? m.realm_bans_details_banned_heading() : m.realm_bans_details_lifted_heading()}
      </ContentItemHeading>
      <dl className="min-w-0 space-y-3">
        <div>
          <dt className="font-medium">{m.realm_bans_details_account()}</dt>
          <dd className="wrap-anywhere">
            <bdi>{accountId}</bdi>
          </dd>
        </div>
        {result.action === 'ban' ? (
          <>
            <BanModeratorIdentity actor={result.ban.actor} />
            <div>
              <dt className="font-medium">{m.realm_bans_details_reason()}</dt>
              <dd className="whitespace-pre-wrap wrap-anywhere">{result.ban.reason || m.realm_bans_no_reason()}</dd>
            </div>
            <div>
              <dt className="font-medium">{m.realm_bans_details_at()}</dt>
              <dd>
                <time dateTime={result.ban.at} dir="ltr" className="wrap-anywhere">
                  {result.ban.at.replace('T', ' ').replace(/Z$/, '')} UTC
                </time>
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      <p>
        {historical
          ? m.realm_bans_receipt_previous()
          : result.action === 'ban'
            ? m.realm_bans_active()
            : m.realm_bans_lifted()}
      </p>
      {result.action === 'ban' && result.ban.workflowId !== null ? <p>{m.realm_bans_removal_pending()}</p> : null}
    </ContentItemFrame>
  );
}

function BanModeratorIdentity({ actor }: { actor: string | null }) {
  return (
    <div>
      <dt className="font-medium">{m.realm_bans_details_moderator()}</dt>
      <dd className="wrap-anywhere">{actor ? <bdi>{actor}</bdi> : m.realm_bans_moderator_erased()}</dd>
    </div>
  );
}

function readMessage(state: Exclude<BanReadState['state'], 'ready'>) {
  switch (state) {
    case 'loading':
      return m.realm_bans_loading();
    case 'signed-out':
      return m.realm_bans_signed_out();
    case 'forbidden':
      return m.realm_bans_forbidden();
    case 'closed':
      return m.realm_bans_closed();
    case 'invalid-cursor':
      return m.realm_bans_cursor_invalid();
    case 'unavailable':
      return m.realm_bans_unavailable();
  }
}

function writeMessage(reason: Extract<BanWriteResult, { ok: false }>['reason']) {
  switch (reason) {
    case 'signed-out':
      return m.realm_bans_signed_out();
    case 'forbidden':
      return m.realm_bans_forbidden();
    case 'closed':
      return m.realm_bans_closed();
    case 'role-required':
      return m.realm_bans_role_required();
    case 'conflict':
      return m.realm_bans_conflict();
    case 'invalid':
      return m.realm_bans_invalid();
    case 'unavailable':
      return m.realm_bans_write_unavailable();
  }
}

function targetMessage(state: BanTargetState['state']) {
  switch (state) {
    case 'pending':
      return m.realm_bans_target_pending();
    case 'invalid':
      return m.realm_bans_target_invalid();
    case 'missing':
      return m.realm_bans_target_missing();
    case 'refused':
      return m.realm_bans_target_refused();
    case 'signed-out':
      return m.realm_bans_signed_out();
    case 'unavailable':
      return m.realm_bans_target_unavailable();
    case 'changed':
      return m.realm_bans_target_changed();
    default:
      return '';
  }
}

function TargetPreview({ target, headingLevel = 3 }: { target: RealmBanTarget; headingLevel?: 3 | 4 }) {
  const { account, lookupHandle } = target;
  return (
    <ContentItemFrame as="div" data-slot="realm-ban-target-preview" className="flex min-w-0 items-center gap-3 p-4">
      <Avatar aria-hidden="true">
        <AvatarFallback>{initials(account.displayName || account.handle)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 space-y-1 wrap-anywhere text-sm">
        <ContentItemHeading level={headingLevel} className="break-words font-medium">
          {account.displayName || `@${account.handle}`}
        </ContentItemHeading>
        <p>@{account.handle}</p>
        {'movedTo' in account && account.movedTo ? (
          <p>{m.realm_bans_target_moved({ former: lookupHandle, current: account.movedTo })}</p>
        ) : null}
      </div>
    </ContentItemFrame>
  );
}

const unavailableTarget: ResolveBanTarget = async () => ({ state: 'unavailable' });

const serverCurrent = () => false;

type BanReviewIntent = {
  action: 'ban' | 'unban';
  target: string;
  trigger: HTMLButtonElement;
  token: number;
  realmId: string;
  caller: number;
  generation: number;
};

type BanFocusRecovery = {
  review: BanReviewIntent;
  source: HTMLButtonElement;
  destination: 'trigger' | 'result';
  generation: number;
  sequence: number;
};

type BanWindowAddress = { realmId: string; visit: number; cursor: string | undefined };
type BanWindowDirection = 'next' | 'previous' | 'refresh' | 'restart';

type PageReadFocusIntent = {
  source: HTMLButtonElement;
  ticket: number;
  caller: number;
  generation: number;
  realmId: string;
  controller: AbortController;
};

function keyboardActivationSource(event: MouseEvent<HTMLButtonElement>) {
  return event.detail === 0 && event.currentTarget === document.activeElement ? event.currentTarget : undefined;
}

/** Departure can run before React commits an edit or a definitive command settlement. */
function useBanDraftField<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  const set = useCallback((next: T) => {
    current.current = next;
    setValue(next);
  }, []);
  return [value, set, current] as const;
}
const retiredInitials = new WeakSet<BanReadState>();

/** Replace the whole private visit synchronously when any original caller source changes. */
export function RealmBansControl(props: RealmBansControlProps) {
  const visit = useRef<{
    props: RealmBansControlProps;
    locale: string;
    gate: RealmBanLifetime;
    initial: BanReadState | undefined;
  } | null>(null);
  const locale = getLocale();
  const old = visit.current;
  if (
    !old ||
    old.locale !== locale ||
    old.props.realmId !== props.realmId ||
    old.props.ready !== props.ready ||
    old.props.read !== props.read ||
    old.props.write !== props.write ||
    old.props.resolve !== props.resolve ||
    old.props.inspect !== props.inspect ||
    old.props.selectedMember !== props.selectedMember ||
    old.props.lifetime !== props.lifetime ||
    old.props.initial !== props.initial
  ) {
    old?.gate.retire();
    if (old?.initial) retiredInitials.add(old.initial);
    visit.current = {
      props,
      locale,
      gate: new RealmBanLifetime(
        () => props.ready && getLocale() === locale && (props.lifetime?.current() ?? true),
        props.lifetime?.subscribe,
        () => {
          if (props.initial) retiredInitials.add(props.initial);
        },
      ),
      // A repeated initial page cannot lend its private data to a replacement caller.
      initial: props.initial && !retiredInitials.has(props.initial) ? props.initial : undefined,
    };
  }
  const current = visit.current!;
  const retired = useSyncExternalStore(current.gate.subscribe, current.gate.snapshot, serverCurrent);
  useLayoutEffect(() => current.gate.connect(), [current]);
  if (retired || !props.ready) return null;
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <RealmBansVisit key={current.gate.id} {...props} initial={current.initial} gate={current.gate} />
    </AuthoringDepartureBoundary>
  );
}

/** A complete Realm management region, composed from the existing administration controls. */
function RealmBansVisit({
  realmId,
  initial,
  read,
  write,
  resolve = unavailableTarget,
  inspect = unavailableRealmBanCurrent,
  selectedMember,
  gate,
}: Omit<RealmBansControlProps, 'initial'> & { initial: BanReadState | undefined; gate: RealmBanLifetime }) {
  const id = useId();
  const [view, setView] = useState<BanReadState>(initial ?? { state: 'loading' });
  const [query, setQuery, queryNow] = useBanDraftField('');
  const [target, setTarget] = useState<BanTargetState>({ state: 'idle' });
  const [selected, setSelected, selectedNow] = useBanDraftField<RealmBanTarget | null>(null);
  const [banConfirm, setBanConfirm, banConfirmNow] = useBanDraftField(false);
  const lookup = useRef<AbortController | null>(null);
  const intent = useRef(0);
  const renderIntent = intent.current;
  const reviewSequence = useRef(0);
  const banReview = useRef<BanReviewIntent | null>(null);
  const unbanReview = useRef<BanReviewIntent | null>(null);
  const completedReview = useRef<BanReviewIntent | null>(null);
  const focusRecovery = useRef<BanFocusRecovery | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const [selectedReview, setSelectedReview] = useState<'ban' | 'unban' | null>(null);
  const selectedReviewIntent = useRef<BanReviewIntent | null>(null);
  const selectedReviewCommand = useRef<{ review: BanReviewIntent; input: BanWriteInput } | null>(null);
  const [selectedReviewReason, setSelectedReviewReason] = useState('');
  const invalidateTarget = useCallback(() => {
    intent.current++;
    reviewSequence.current++;
    banReview.current = null;
    completedReview.current = null;
    focusRecovery.current = null;
    lookup.current?.abort();
    lookup.current = null;
    setTarget({ state: 'idle' });
    setSelected(null);
    setBanConfirm(false);
    selectedReviewIntent.current = null;
    selectedReviewCommand.current = null;
    setSelectedReview(null);
    setSelectedReviewReason('');
  }, [setSelected, setBanConfirm, setSelectedReview, setSelectedReviewReason]);
  const [reason, setReason, reasonNow] = useBanDraftField('');
  const [confirmedEpisode, setConfirmedEpisode] = useState<Readonly<RealmBanRow> | null>(null);
  const [confirm, setConfirm, confirmNow] = useBanDraftField<string | null>(null);
  const [result, setResult] = useState<BanWriteResult | null>(null);
  // Bounded command receipts are independent of the selected episode and readback.
  // A new command replaces only the previous receipt for its own action.
  const [receipts, setReceipts] = useState<
    readonly { input: Readonly<BanWriteInput>; result: Extract<BanWriteResult, { ok: true }> }[]
  >([]);
  const [retry, setRetry] = useState<BanWriteInput | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef<object | null>(null);
  const generation = useRef(0);
  const renderGeneration = generation.current;
  const pageReady = useRef(initial?.state === 'ready');
  // Addresses never retain a body or outlive this admitted Realm visit.
  const windows = useRef<{
    active: BanWindowAddress;
    previous: BanWindowAddress[];
    discarded: boolean;
  }>({ active: { realmId, visit: gate.id, cursor: undefined }, previous: [], discarded: false });
  const pageRead = useRef<{
    cursor?: string | undefined;
    direction?: BanWindowDirection;
    focus: PageReadFocusIntent | null;
  }>({ focus: null });
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const currentListHeading = useRef<HTMLHeadingElement>(null);
  const banTrigger = useRef<HTMLButtonElement>(null);
  const restartAction = useRef<HTMLButtonElement>(null);
  const retryReadAction = useRef<HTMLButtonElement>(null);
  const uncertain = useRef<BanWriteInput | null>(null);
  const visible = useCommunityManagementAdmission('bans', gate.current() && view.state === 'ready');

  function cancelPageReadFocus() {
    pageRead.current.focus?.controller.abort();
  }

  function createPageReadFocusIntent(
    source: HTMLButtonElement,
    ticket: number,
    readGeneration: number,
  ): PageReadFocusIntent {
    const controller = new AbortController();
    const focus = { source, ticket, caller: gate.id, generation: readGeneration, realmId, controller };
    controller.signal.addEventListener(
      'abort',
      () => {
        if (pageRead.current.focus === focus) pageRead.current = { ...pageRead.current, focus: null };
      },
      { once: true },
    );
    document.addEventListener('pointerdown', () => controller.abort(), { capture: true, signal: controller.signal });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Tab') controller.abort();
      },
      { capture: true, signal: controller.signal },
    );
    document.addEventListener(
      'focusin',
      (event) => {
        if (event.target !== source && event.target !== document.body) controller.abort();
      },
      { capture: true, signal: controller.signal },
    );
    return focus;
  }

  useLayoutEffect(() => () => pageRead.current.focus?.controller.abort(), [gate]);

  useLayoutEffect(() => {
    const focus = pageRead.current.focus;
    if (!focus || view.state === 'loading') return;
    if (
      focus.generation !== generation.current ||
      focus.caller !== gate.id ||
      focus.realmId !== realmId ||
      !gate.owns(focus.ticket) ||
      !visible
    ) {
      focus.controller.abort();
      return;
    }
    const active = document.activeElement;
    if (active !== focus.source && active !== document.body) {
      focus.controller.abort();
      return;
    }
    const boundary = view.state === 'ready' ? pageHeading.current : (retryReadAction.current ?? restartAction.current);
    focus.controller.abort();
    if (boundary?.isConnected) boundary.focus();
  }, [view, visible, gate, realmId]);

  useLayoutEffect(() => {
    const request = focusRecovery.current;
    if (!request) return;
    const { review } = request;
    if (
      request.sequence !== reviewSequence.current ||
      completedReview.current !== review ||
      request.generation !== generation.current ||
      request.generation !== renderGeneration ||
      review.caller !== gate.id ||
      review.realmId !== realmId ||
      !gate.current()
    ) {
      focusRecovery.current = null;
      return;
    }
    const active = document.activeElement;
    if (active !== request.source && active !== document.body) {
      focusRecovery.current = null;
      return;
    }
    const destination =
      request.destination === 'trigger'
        ? review.action === 'ban'
          ? selectedNow.current?.account.id === review.target ||
            (selectedMember !== undefined && selectedMember.accountId === review.target && selectedMember.current())
            ? review.trigger
            : null
          : view.state === 'ready'
            ? review.trigger
            : null
        : result?.ok && (result.action === 'ban' ? result.ban.accountId : result.accountId) === review.target
          ? document.getElementById(`${id}-outcome`)
          : null;
    focusRecovery.current = null;
    const boundary = destination?.isConnected
      ? destination
      : view.state === 'ready'
        ? currentListHeading.current
        : pageHeading.current;
    boundary?.focus();
  }, [view, result, confirm, banConfirm, focusRevision, gate, realmId, id, selectedMember]);

  function makeReview(action: BanReviewIntent['action'], target: string, trigger: HTMLButtonElement): BanReviewIntent {
    const review = {
      action,
      target,
      trigger,
      token: ++reviewSequence.current,
      realmId,
      caller: gate.id,
      generation: generation.current,
    };
    focusRecovery.current = null;
    completedReview.current = null;
    if (action === 'ban') banReview.current = review;
    else unbanReview.current = review;
    return review;
  }

  function matchesReview(review: BanReviewIntent, action: BanReviewIntent['action'], target: string) {
    return (
      review.action === action &&
      review.target === target &&
      review.realmId === realmId &&
      review.caller === gate.id &&
      review.generation === generation.current &&
      gate.current()
    );
  }

  function recoverFocus(
    review: BanReviewIntent,
    source: HTMLButtonElement,
    destination: BanFocusRecovery['destination'],
    generation: number,
    sourceWasFocused: boolean,
  ) {
    const sequence = ++reviewSequence.current;
    completedReview.current = sourceWasFocused ? review : null;
    focusRecovery.current = sourceWasFocused ? { review, source, destination, generation, sequence } : null;
    setFocusRevision(sequence);
  }

  const unresolved = () => gate.current() && (working.current !== null || uncertain.current !== null);
  const departure = useAuthoringDeparture(
    () =>
      gate.current() &&
      (queryNow.current.length > 0 ||
        reasonNow.current.length > 0 ||
        selectedNow.current !== null ||
        banConfirmNow.current ||
        confirmNow.current !== null ||
        selectedReviewIntent.current !== null ||
        unresolved()),
    unresolved,
    JSON.stringify([gate.id, query, reason, selected?.account.id, banConfirm, confirm, busy, retry?.idempotencyKey]),
    undefined,
    () => {
      // Retire admission and all local continuations before the router starts destination reads.
      gate.retire();
      lookup.current?.abort();
      lookup.current = null;
      intent.current++;
      generation.current++;
      working.current = null;
      uncertain.current = null;
      pageReady.current = false;
      cancelPageReadFocus();
      pageRead.current = { focus: null };
      windows.current = { active: { realmId, visit: gate.id, cursor: undefined }, previous: [], discarded: false };
    },
    'realm-ban',
    undefined,
    undefined,
    () => {
      // Local browse departure retires the page review, preserving this visit's addresses and receipts.
      invalidateTarget();
      unbanReview.current = null;
      setConfirm(null);
      setQuery('');
      setReason('');
      pageReady.current = false;
      generation.current++;
    },
  );

  const refresh = useCallback(
    async (cursor?: string, focusSource?: HTMLButtonElement, direction: BanWindowDirection = 'restart') => {
      if (!gate.current() || working.current || uncertain.current) return;
      cancelPageReadFocus();
      pageReady.current = false;
      // Restart is deliberate recovery even when its new first-page read fails.
      if (direction === 'restart') {
        cursor = undefined;
        windows.current.previous = [];
        windows.current.discarded = false;
      }
      pageRead.current = { cursor, direction, focus: null };
      const ticket = gate.ticket();
      const current = ++generation.current;
      if (focusSource) pageRead.current.focus = createPageReadFocusIntent(focusSource, ticket, current);
      const owns = () => gate.owns(ticket) && generation.current === current;
      invalidateTarget();
      unbanReview.current = null;
      setConfirm(null);
      selectedReviewIntent.current = null;
      selectedReviewCommand.current = null;
      setSelectedReview(null);
      setSelectedReviewReason('');
      setView({ state: 'loading' });
      let next: BanReadState;
      try {
        // Fence queued transports as well as their results.
        await Promise.resolve();
        if (!owns()) return;
        next = await read(cursor);
      } catch {
        next = { state: 'unavailable' };
      }
      if (generation.current !== current) return;
      if (!gate.owns(ticket)) return;
      pageReady.current = next.state === 'ready';
      if (next.state === 'ready') {
        const history = windows.current;
        if (direction === 'next') {
          history.previous.push(history.active);
          if (history.previous.length > 8) {
            history.previous.shift();
            history.discarded = true;
          }
        } else if (direction === 'previous') history.previous.pop();
        history.active = { realmId, visit: gate.id, cursor };
      }
      setView(next);
      if (next.state === 'forbidden' || next.state === 'closed' || next.state === 'signed-out') {
        windows.current = { active: { realmId, visit: gate.id, cursor: undefined }, previous: [], discarded: false };
        pageRead.current = { focus: pageRead.current.focus };
        setResult(null);
        setReceipts([]);
        setRetry(null);
        setSelectedReview(null);
        selectedReviewIntent.current = null;
        selectedReviewCommand.current = null;
        setSelectedReviewReason('');
        setQuery('');
        setReason('');
      }
    },
    [
      read,
      realmId,
      invalidateTarget,
      gate,
      setConfirm,
      setQuery,
      setReason,
      setSelectedReview,
      setSelectedReviewReason,
    ],
  );

  function browse(direction: BanWindowDirection, cursor: string | undefined, event: MouseEvent<HTMLButtonElement>) {
    if (!gate.current() || working.current || uncertain.current || generation.current !== renderGeneration) return;
    const ticket = gate.ticket();
    const source = keyboardActivationSource(event);
    departure.requestNavigation(() => {
      if (!gate.owns(ticket) || working.current || uncertain.current) return;
      void refresh(cursor, source && document.activeElement === source ? source : undefined, direction);
    });
  }

  useEffect(() => {
    setBusy(false);
    if (initial === undefined) void refresh();
    return () => {
      lookup.current?.abort();
      lookup.current = null;
      working.current = null;
    };
  }, [initial, refresh]);

  function acquire() {
    if (
      !gate.current() ||
      working.current ||
      !pageReady.current ||
      renderGeneration !== generation.current ||
      renderIntent !== intent.current
    )
      return null;
    const operation = {};
    const ticket = gate.ticket();
    const readGeneration = generation.current;
    working.current = operation;
    setBusy(true);
    return {
      owns: () => gate.owns(ticket) && working.current === operation && generation.current === readGeneration,
      release: () => {
        if (working.current !== operation) return;
        working.current = null;
        if (gate.owns(ticket)) setBusy(false);
      },
    };
  }

  async function send(
    input: BanWriteInput,
    operation: NonNullable<ReturnType<typeof acquire>>,
    origin?: { review: BanReviewIntent; source: HTMLButtonElement },
  ) {
    if (!operation.owns()) return;
    setResult(null);
    let next: BanWriteResult;
    try {
      await Promise.resolve();
      if (!operation.owns()) return;
      next = await write(input);
    } catch {
      next = { ok: false, reason: 'unavailable' };
    }
    if (!operation.owns()) return;
    const restoreResultFocus =
      next.ok &&
      origin !== undefined &&
      origin.review.target === input.accountId &&
      matchesReview(origin.review, input.action, input.accountId) &&
      (origin.review.action === 'ban' ? banReview.current : unbanReview.current) === origin.review &&
      document.activeElement === origin.source;
    if (next.ok) {
      // Copy native acceptance before retaining it across subsequent commands.
      const accepted = Object.freeze(
        next.action === 'ban' ? { ...next, ban: Object.freeze({ ...next.ban }) } : { ...next },
      );
      setReceipts((previous) => [
        ...previous.filter((receipt) => receipt.result.action !== accepted.action),
        { input, result: accepted },
      ]);
      setResult(accepted);
    } else {
      setResult(next);
    }
    uncertain.current = !next.ok && next.reason === 'unavailable' ? input : null;
    setRetry(uncertain.current);
    selectedReviewIntent.current = null;
    selectedReviewCommand.current = null;
    setSelectedReview(null);
    setSelectedReviewReason('');
    if (next.ok) {
      banReview.current = null;
      unbanReview.current = null;
      setConfirm(null);
      if (input.action === 'ban') {
        invalidateTarget();
        setQuery('');
        setReason('');
      }
      operation.release();
      await refresh();
      if (origin) recoverFocus(origin.review, origin.source, 'result', generation.current, restoreResultFocus);
    } else if (next.reason === 'forbidden' || next.reason === 'signed-out' || next.reason === 'closed') {
      setReceipts([]);
      invalidateTarget();
      unbanReview.current = null;
      setQuery('');
      setReason('');
      pageReady.current = false;
      setView({ state: next.reason });
      setConfirm(null);
    }
  }

  async function change(input: BanWriteInput, origin?: { review: BanReviewIntent; source: HTMLButtonElement }) {
    if (uncertain.current && uncertain.current !== input) return;
    const operation = acquire();
    if (!operation) return;
    // The uncertain command is immutable and is retried only by explicit activation.
    const command = Object.freeze({ ...input });
    try {
      await send(command, operation, origin);
    } finally {
      operation.release();
    }
  }

  async function findTarget() {
    if (
      !gate.current() ||
      working.current ||
      uncertain.current ||
      !pageReady.current ||
      renderGeneration !== generation.current ||
      renderIntent !== intent.current
    )
      return;
    invalidateTarget();
    const handle = parseRealmBanTarget(query, window.location.origin);
    if (!handle) {
      setTarget({ state: 'invalid' });
      return;
    }
    const controller = new AbortController();
    const ticket = gate.ticket();
    const readGeneration = generation.current;
    lookup.current = controller;
    const owns = () =>
      gate.owns(ticket) &&
      generation.current === readGeneration &&
      !controller.signal.aborted &&
      lookup.current === controller;
    setTarget({ state: 'pending' });
    let next: BanTargetState;
    try {
      await Promise.resolve();
      if (!owns()) return;
      next = await resolve(handle, controller.signal);
    } catch {
      next = { state: 'unavailable' };
    }
    if (!owns()) return;
    setTarget(next);
    if (next.state === 'signed-out') {
      pageReady.current = false;
      setView({ state: 'signed-out' });
      setQuery('');
      setReason('');
      setResult(null);
      setReceipts([]);
    }
  }

  async function submitBan(source: HTMLButtonElement) {
    const review = banReview.current;
    if (
      uncertain.current ||
      !selected ||
      !banConfirm ||
      target.state !== 'ready' ||
      !review ||
      !matchesReview(review, 'ban', selected.account.id)
    )
      return;
    const operation = acquire();
    if (!operation) return;
    const reviewed = selected;
    const command = Object.freeze({
      realmId,
      accountId: reviewed.account.id,
      reason,
      action: 'ban' as const,
      idempotencyKey: crypto.randomUUID(),
    });
    const controller = new AbortController();
    lookup.current?.abort();
    lookup.current = controller;
    try {
      await Promise.resolve();
      if (!operation.owns()) return;
      let current: BanTargetState;
      try {
        current = await revalidateRealmBanTarget(resolve, reviewed, controller.signal);
      } catch {
        current = { state: 'unavailable' };
      }
      if (!operation.owns() || controller.signal.aborted || lookup.current !== controller) return;
      if (current.state !== 'ready') {
        invalidateTarget();
        setTarget(current);
        if (current.state === 'signed-out') {
          pageReady.current = false;
          setView({ state: 'signed-out' });
          setQuery('');
          setReason('');
          setResult(null);
          setReceipts([]);
        }
        return;
      }
      setTarget(current);
      // The same synchronous owner covers revalidation through the final send.
      await send(command, operation, { review, source });
    } finally {
      operation.release();
    }
  }

  const disabled = busy || retry !== null;
  if (!visible || !gate.current()) return null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-5 wrap-anywhere"
      aria-busy={busy || view.state === 'loading'}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={pageHeading} tabIndex={-1} id={`${id}-title`} className="text-xl font-semibold">
          {m.realm_bans_heading()}
        </h2>
        <div className="flex min-w-0 flex-wrap gap-2">
          {view.state === 'ready' ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={disabled}
              onClick={(event) => browse('refresh', windows.current.active.cursor, event)}
            >
              {m.realm_bans_refresh()}
            </Button>
          ) : null}
          <Button
            ref={restartAction}
            type="button"
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
            disabled={disabled || view.state === 'loading'}
            onClick={(event) => browse('restart', undefined, event)}
          >
            {m.realm_bans_restart()}
          </Button>
        </div>
      </div>
      {view.state !== 'ready' ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {readMessage(view.state)}
          </p>
          {view.state === 'unavailable' ? (
            <Button
              ref={retryReadAction}
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={disabled}
              onClick={(event) => {
                if (!gate.current() || generation.current !== renderGeneration) return;
                browse(pageRead.current.direction ?? 'refresh', pageRead.current.cursor, event);
              }}
            >
              {m.realm_bans_read_retry()}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">{m.realm_bans_help()}</p>
          <form
            className="min-w-0 max-w-xl space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                gate.current() &&
                !working.current &&
                !uncertain.current &&
                !disabled &&
                selected &&
                banTrigger.current &&
                !banConfirmNow.current
              ) {
                makeReview('ban', selected.account.id, banTrigger.current);
                setBanConfirm(true);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-account`}>{m.realm_bans_account()}</FieldLabel>
              <Input
                id={`${id}-account`}
                className="min-h-11 min-w-11"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                aria-describedby={`${id}-target-help`}
                value={query}
                disabled={disabled}
                onChange={(event) => {
                  if (!gate.current() || working.current || uncertain.current) return;
                  invalidateTarget();
                  setQuery(event.target.value);
                }}
              />
              <p id={`${id}-target-help`} className="text-sm text-muted-foreground">
                {m.realm_bans_target_help()}
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                disabled={disabled || !query.trim() || target.state === 'pending'}
                onClick={() => void findTarget()}
              >
                {m.realm_bans_target_lookup()}
              </Button>
            </Field>
            {target.state === 'ready' ? (
              <div className="space-y-3">
                <TargetPreview target={target.target} />
                {selected ? (
                  <p role="status" className="text-sm">
                    {m.realm_bans_target_selected()}
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                    disabled={disabled}
                    onClick={() => {
                      if (!gate.current() || working.current || uncertain.current) return;
                      if (renderIntent !== intent.current || renderGeneration !== generation.current) return;
                      intent.current++;
                      reviewSequence.current++;
                      focusRecovery.current = null;
                      completedReview.current = null;
                      setSelected(target.target);
                      setBanConfirm(false);
                    }}
                  >
                    {m.realm_bans_target_select()}
                  </Button>
                )}
              </div>
            ) : target.state !== 'idle' ? (
              <p role="status" className="text-sm">
                {targetMessage(target.state)}
              </p>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>{m.realm_bans_reason()}</FieldLabel>
              <Textarea
                id={`${id}-reason`}
                className="min-w-0 max-w-full pointer-coarse:min-w-11"
                maxLength={1024}
                value={reason}
                disabled={disabled}
                onChange={(event) => {
                  if (!gate.current() || working.current || uncertain.current) return;
                  intent.current++;
                  reviewSequence.current++;
                  banReview.current = null;
                  unbanReview.current = null;
                  focusRecovery.current = null;
                  completedReview.current = null;
                  selectedReviewIntent.current = null;
                  selectedReviewCommand.current = null;
                  setSelectedReview(null);
                  setSelectedReviewReason('');
                  setReason(event.target.value);
                  setBanConfirm(false);
                }}
              />
            </Field>
            <Button
              ref={banTrigger}
              type="submit"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={disabled || !selected || target.state !== 'ready'}
            >
              {m.realm_bans_ban()}
            </Button>
            {banConfirm && selected ? (
              <ContentItemFrame
                as="div"
                role="group"
                aria-labelledby={`${id}-ban-confirm`}
                className="min-w-0 space-y-3 wrap-anywhere p-4"
              >
                <ContentItemHeading
                  level={3}
                  id={`${id}-ban-confirm`}
                  className="line-clamp-none font-medium leading-6"
                >
                  {m.realm_bans_ban_confirm()}
                </ContentItemHeading>
                <TargetPreview target={selected} headingLevel={4} />
                <dl className="min-w-0 text-sm">
                  <div>
                    <dt className="font-medium">{m.realm_bans_details_account()}</dt>
                    <dd className="wrap-anywhere">
                      <bdi>{selected.account.id}</bdi>
                    </dd>
                  </div>
                </dl>
                <p className="whitespace-pre-wrap wrap-anywhere text-sm">{reason || m.realm_bans_no_reason()}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                    disabled={disabled}
                    onClick={(event) => void submitBan(event.currentTarget)}
                  >
                    {m.realm_bans_confirm_ban()}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                    disabled={disabled}
                    onClick={(event) => {
                      const review = banReview.current;
                      if (
                        gate.current() &&
                        !working.current &&
                        review &&
                        matchesReview(review, 'ban', selected.account.id)
                      ) {
                        const focused = document.activeElement === event.currentTarget;
                        banReview.current = null;
                        intent.current++;
                        recoverFocus(review, event.currentTarget, 'trigger', generation.current, focused);
                        setBanConfirm(false);
                      }
                    }}
                  >
                    {m.realm_bans_cancel()}
                  </Button>
                </div>
              </ContentItemFrame>
            ) : null}
          </form>
          {selectedMember && selectedMember.realmId === realmId ? (
            <section
              aria-labelledby={`${id}-selected-member-heading`}
              className="min-w-0 space-y-3 rounded-xl border p-4"
            >
              <h3 id={`${id}-selected-member-heading`} className="font-semibold">
                {m.realm_members_inspection()}
              </h3>
              <p className="break-words">
                <bdi>{selectedMember.label}</bdi>
                {' · '}
                <bdi>{selectedMember.accountId}</bdi>
              </p>
              <p className="text-sm text-muted-foreground">
                {m.realm_members_selected_account_in_realm({
                  account: selectedMember.label,
                  realm: selectedMember.realmLabel,
                })}
              </p>
              {selectedMember.advice.ban === 'available' ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                  disabled={disabled}
                  onClick={(event) => {
                    if (!gate.current() || !selectedMember.current() || working.current || uncertain.current) return;
                    intent.current++;
                    const review = makeReview('ban', selectedMember.accountId, event.currentTarget);
                    const input = Object.freeze({
                      realmId,
                      accountId: selectedMember.accountId,
                      reason: reasonNow.current,
                      action: 'ban' as const,
                      idempotencyKey: crypto.randomUUID(),
                    });
                    selectedReviewIntent.current = review;
                    selectedReviewCommand.current = { review, input };
                    setSelectedReviewReason(input.reason);
                    setSelectedReview('ban');
                  }}
                >
                  {m.realm_bans_ban()}
                </Button>
              ) : null}
              {selectedMember.advice.unban === 'available' ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                  disabled={disabled}
                  onClick={(event) => {
                    if (!gate.current() || !selectedMember.current() || working.current || uncertain.current) return;
                    intent.current++;
                    const review = makeReview('unban', selectedMember.accountId, event.currentTarget);
                    const input = Object.freeze({
                      realmId,
                      accountId: selectedMember.accountId,
                      reason: '',
                      action: 'unban' as const,
                      idempotencyKey: crypto.randomUUID(),
                    });
                    selectedReviewIntent.current = review;
                    selectedReviewCommand.current = { review, input };
                    setSelectedReviewReason('');
                    setSelectedReview('unban');
                  }}
                >
                  {m.realm_bans_unban()}
                </Button>
              ) : null}
              {selectedMember.advice.ban === 'unknown' || selectedMember.advice.unban === 'unknown' ? (
                <p role="status" className="text-sm">
                  {m.realm_members_actions_unavailable()}
                </p>
              ) : null}
              {selectedReview && selectedMember.current() ? (
                <div role="group" aria-labelledby={`${id}-selected-review`} className="space-y-3 rounded-lg border p-4">
                  <h4 id={`${id}-selected-review`} className="font-medium">
                    {selectedReview === 'ban' ? m.realm_bans_ban() : m.realm_bans_unban_confirm()}
                  </h4>
                  <p>
                    {m.realm_members_selected_review({
                      action: selectedReview === 'ban' ? m.realm_bans_ban() : m.realm_bans_unban(),
                      account: selectedMember.label,
                      realm: selectedMember.realmLabel,
                    })}
                  </p>
                  <p className="text-sm">
                    <bdi>{selectedMember.reference}</bdi>
                    {' · '}
                    <bdi>{selectedMember.accountId}</bdi>
                    {' · '}
                    <bdi>{realmId}</bdi>
                  </p>
                  {selectedReview === 'ban' ? (
                    <p className="text-sm">
                      {m.realm_bans_reason()}: {selectedReviewReason || '—'}
                    </p>
                  ) : null}
                  {selectedReview === 'ban' ? <p className="text-sm">{m.realm_bans_help()}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                      disabled={disabled}
                      onClick={(event) => {
                        const review = selectedReviewIntent.current;
                        const command = selectedReviewCommand.current;
                        if (
                          !review ||
                          !command ||
                          command.review !== review ||
                          !selectedMember.current() ||
                          review.action !== selectedReview ||
                          !matchesReview(review, selectedReview, selectedMember.accountId)
                        )
                          return;
                        void change(command.input, { review, source: event.currentTarget });
                      }}
                    >
                      {selectedReview === 'ban' ? m.realm_bans_confirm_ban() : m.realm_bans_confirm()}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                      disabled={disabled}
                      onClick={(event) => {
                        const review = selectedReviewIntent.current;
                        if (
                          !review ||
                          !selectedMember.current() ||
                          !matchesReview(review, selectedReview, selectedMember.accountId)
                        )
                          return;
                        const focused = document.activeElement === event.currentTarget;
                        if (review.action === 'ban') banReview.current = null;
                        else unbanReview.current = null;
                        selectedReviewIntent.current = null;
                        selectedReviewCommand.current = null;
                        setSelectedReviewReason('');
                        intent.current++;
                        recoverFocus(review, event.currentTarget, 'trigger', generation.current, focused);
                        setSelectedReview(null);
                      }}
                    >
                      {m.realm_bans_cancel()}
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          {view.page.context?.state === 'available' ? (
            <p className="text-sm">
              <bdi>{view.page.context.spaceTitle}</bdi> / <bdi>{view.page.context.realmTitle}</bdi>
            </p>
          ) : null}
          <RealmBanCurrentControl
            key={renderGeneration}
            realmId={realmId}
            inspect={inspect}
            cursor={pageRead.current.cursor}
            gate={gate}
            disabled={disabled}
            unban={(observation, trigger, source) => {
              if (
                !gate.current() ||
                working.current ||
                uncertain.current ||
                renderGeneration !== generation.current ||
                observation.input.realmId !== realmId ||
                observation.input.cursor !== pageRead.current.cursor ||
                observation.ban.accountId !== observation.input.accountId
              )
                return;
              const review = makeReview('unban', observation.input.accountId, trigger);
              void change(
                {
                  realmId,
                  accountId: observation.input.accountId,
                  action: 'unban',
                  reason: '',
                  idempotencyKey: crypto.randomUUID(),
                },
                { review, source },
              );
            }}
          />
          <h3 ref={currentListHeading} tabIndex={-1} className="font-semibold">
            {m.realm_bans_current()}
          </h3>
          {view.page.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.realm_bans_empty()}</p>
          ) : (
            <ul aria-label={m.realm_bans_current()} className="min-w-0 space-y-3">
              {view.page.items.map((ban) => (
                <ContentItem
                  key={ban.accountId}
                  title={m.realm_bans_details_banned_heading()}
                  headingLevel={4}
                  className="wrap-anywhere [&_h4]:line-clamp-none [&_h4]:whitespace-normal"
                  metadata={
                    <div className="min-w-0 flex-1 space-y-3">
                      <RealmBanEpisodeView ban={ban} />
                      <RealmBanNativeAdvice ban={ban} realmId={realmId} />
                    </div>
                  }
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                      disabled={disabled || (!!ban.unban && !realmBanEpisodeAdvice(ban, realmId))}
                      onClick={(event) => {
                        if (
                          gate.current() &&
                          !working.current &&
                          !uncertain.current &&
                          renderGeneration === generation.current
                        ) {
                          intent.current++;
                          makeReview('unban', ban.accountId, event.currentTarget);
                          setConfirmedEpisode(copyRealmBanEpisode(ban));
                          setConfirm(ban.accountId);
                        }
                      }}
                    >
                      {m.realm_bans_unban()}
                    </Button>
                  }
                  preview={
                    confirm === ban.accountId ? (
                      <ContentItemFrame
                        as="div"
                        role="group"
                        aria-labelledby={`${id}-unban-${ban.accountId}`}
                        className="min-w-0 space-y-3 wrap-anywhere p-4"
                      >
                        <ContentItemHeading
                          level={4}
                          id={`${id}-unban-${ban.accountId}`}
                          className="line-clamp-none font-medium leading-6"
                        >
                          {m.realm_bans_unban_confirm()}
                        </ContentItemHeading>
                        {confirmedEpisode?.accountId === ban.accountId ? (
                          <RealmBanEpisodeView ban={confirmedEpisode} />
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                            disabled={disabled}
                            onClick={(event) => {
                              const review = unbanReview.current;
                              if (!review || !matchesReview(review, 'unban', ban.accountId)) return;
                              void change(
                                {
                                  realmId,
                                  accountId: ban.accountId,
                                  reason: '',
                                  action: 'unban',
                                  idempotencyKey: crypto.randomUUID(),
                                },
                                { review, source: event.currentTarget },
                              );
                            }}
                          >
                            {m.realm_bans_confirm()}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                            disabled={disabled}
                            onClick={(event) => {
                              const review = unbanReview.current;
                              if (
                                gate.current() &&
                                !working.current &&
                                review &&
                                matchesReview(review, 'unban', ban.accountId)
                              ) {
                                const focused = document.activeElement === event.currentTarget;
                                unbanReview.current = null;
                                intent.current++;
                                recoverFocus(review, event.currentTarget, 'trigger', generation.current, focused);
                                setConfirm(null);
                              }
                            }}
                          >
                            {m.realm_bans_cancel()}
                          </Button>
                        </div>
                      </ContentItemFrame>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={disabled || windows.current.previous.length === 0}
              onClick={(event) => browse('previous', windows.current.previous.at(-1)!.cursor, event)}
            >
              {m.realm_bans_previous()}
            </Button>
            {view.page.next ? (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                disabled={disabled}
                onClick={(event) => {
                  if (!gate.current() || generation.current !== renderGeneration) return;
                  browse('next', view.page.next ?? undefined, event);
                }}
              >
                {m.realm_bans_next()}
              </Button>
            ) : null}
          </div>
          {windows.current.discarded && windows.current.previous.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.realm_bans_history_discarded()}</p>
          ) : null}
        </>
      )}
      {view.state === 'ready' || view.state === 'loading' || view.state === 'unavailable'
        ? receipts.map((receipt) => (
            <RealmBanOutcome
              key={receipt.input.idempotencyKey}
              result={receipt.result}
              historical={receipt.result !== result}
              {...(receipt.result === result ? { boundaryId: `${id}-outcome` } : {})}
            />
          ))
        : null}
      {result && !result.ok ? (
        <div role="alert" className="space-y-3 text-sm">
          <p>{writeMessage(result.reason)}</p>
          {retry ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={busy || view.state !== 'ready'}
              onClick={() => void change(retry)}
            >
              {m.realm_bans_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
