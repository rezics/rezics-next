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
import {
  parseRealmBanTarget,
  revalidateRealmBanTarget,
  type BanTargetState,
  type RealmBanTarget,
  type ResolveBanTarget,
} from './realm-ban-target';
import type { BanReadState, BanWriteInput, BanWriteResult } from './realm-bans';
import { RealmBanLifetime } from './realm-ban-lifetime';
import { useCommunityManagementAdmission } from './community-management';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';

export type RealmBansControlProps = {
  realmId: string;
  /** Default Panel admission; standalone fixtures may omit it. */
  lifetime?: RealmBanLifetime;
  initial?: BanReadState;
  ready: boolean;
  resolve?: ResolveBanTarget;
  read: (cursor?: string) => Promise<BanReadState>;
  write: (input: BanWriteInput) => Promise<BanWriteResult>;
};

/** Native acceptance is distinct from completion of Accounts' membership removal. */
export function RealmBanOutcome({
  result,
  boundaryId,
}: {
  result: Extract<BanWriteResult, { ok: true }>;
  boundaryId?: string;
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
      <p>{result.action === 'ban' ? m.realm_bans_active() : m.realm_bans_lifted()}</p>
      {result.action === 'ban' && result.ban.workflowId !== null ? <p>{m.realm_bans_removal_pending()}</p> : null}
    </ContentItemFrame>
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
    gate: RealmBanLifetime;
    initial: BanReadState | undefined;
  } | null>(null);
  const old = visit.current;
  if (
    !old ||
    old.props.realmId !== props.realmId ||
    old.props.ready !== props.ready ||
    old.props.read !== props.read ||
    old.props.write !== props.write ||
    old.props.resolve !== props.resolve ||
    old.props.lifetime !== props.lifetime ||
    old.props.initial !== props.initial
  ) {
    old?.gate.retire();
    if (old?.initial) retiredInitials.add(old.initial);
    visit.current = {
      props,
      gate: new RealmBanLifetime(
        () => props.ready && (props.lifetime?.current() ?? true),
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
  }, [setSelected, setBanConfirm]);
  const [reason, setReason, reasonNow] = useBanDraftField('');
  const [confirm, setConfirm, confirmNow] = useBanDraftField<string | null>(null);
  const [result, setResult] = useState<BanWriteResult | null>(null);
  const [retry, setRetry] = useState<BanWriteInput | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef<object | null>(null);
  const generation = useRef(0);
  const renderGeneration = generation.current;
  const pageReady = useRef(initial?.state === 'ready');
  // Retain only this visit's last bounded page input, including a failed continuation.
  const pageRead = useRef<{ cursor?: string | undefined; focus: PageReadFocusIntent | null }>({ focus: null });
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

  useLayoutEffect(
    () => () => pageRead.current.focus?.controller.abort(),
    [gate],
  );

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
          ? selectedNow.current?.account.id === review.target
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
  }, [view, result, confirm, banConfirm, focusRevision, gate, realmId, id]);

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
  useAuthoringDeparture(
    () =>
      gate.current() &&
      (queryNow.current.length > 0 ||
        reasonNow.current.length > 0 ||
        selectedNow.current !== null ||
        banConfirmNow.current ||
        confirmNow.current !== null ||
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
    },
    'realm-ban',
  );

  const refresh = useCallback(
    async (cursor?: string, focusSource?: HTMLButtonElement) => {
      if (!gate.current() || working.current || uncertain.current) return;
      cancelPageReadFocus();
      pageReady.current = false;
      pageRead.current = { cursor, focus: null };
      const ticket = gate.ticket();
      const current = ++generation.current;
      if (focusSource) pageRead.current.focus = createPageReadFocusIntent(focusSource, ticket, current);
      const owns = () => gate.owns(ticket) && generation.current === current;
      invalidateTarget();
      unbanReview.current = null;
      setConfirm(null);
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
      setView(next);
      if (next.state === 'forbidden' || next.state === 'closed' || next.state === 'signed-out') {
        setResult(null);
        setRetry(null);
        setQuery('');
        setReason('');
      }
    },
    [read, invalidateTarget, gate, setConfirm, setQuery, setReason],
  );

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
    setResult(next);
    uncertain.current = !next.ok && next.reason === 'unavailable' ? input : null;
    setRetry(uncertain.current);
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
        <Button
          ref={restartAction}
          type="button"
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
          disabled={disabled || view.state === 'loading'}
          onClick={(event) => {
            if (!gate.current() || generation.current !== renderGeneration) return;
            setConfirm(null);
            void refresh(undefined, keyboardActivationSource(event));
          }}
        >
          {view.state === 'unavailable' || view.state === 'invalid-cursor'
            ? m.realm_bans_restart()
            : m.realm_bans_refresh()}
        </Button>
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
                void refresh(pageRead.current.cursor, keyboardActivationSource(event));
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
                  focusRecovery.current = null;
                  completedReview.current = null;
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
                    <dl className="min-w-0 flex-1 space-y-3">
                      <div>
                        <dt className="font-medium">{m.realm_bans_details_account()}</dt>
                        <dd className="wrap-anywhere">
                          <bdi>{ban.accountId}</bdi>
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium">{m.realm_bans_details_reason()}</dt>
                        <dd className="whitespace-pre-wrap wrap-anywhere">{ban.reason || m.realm_bans_no_reason()}</dd>
                      </div>
                      <div>
                        <dt className="font-medium">{m.realm_bans_details_at()}</dt>
                        <dd>
                          <time dateTime={ban.at} dir="ltr" className="wrap-anywhere">
                            {ban.at.replace('T', ' ').replace(/Z$/, '')} UTC
                          </time>
                        </dd>
                      </div>
                    </dl>
                  }
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
                      disabled={disabled}
                      onClick={(event) => {
                        if (
                          gate.current() &&
                          !working.current &&
                          !uncertain.current &&
                          renderGeneration === generation.current
                        ) {
                          intent.current++;
                          makeReview('unban', ban.accountId, event.currentTarget);
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
                        <dl className="min-w-0">
                          <div>
                            <dt className="font-medium">{m.realm_bans_details_account()}</dt>
                            <dd className="wrap-anywhere">
                              <bdi>{ban.accountId}</bdi>
                            </dd>
                          </div>
                        </dl>
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
          {view.page.next ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2"
              disabled={disabled}
              onClick={(event) => {
                if (!gate.current() || generation.current !== renderGeneration) return;
                setConfirm(null);
                void refresh(view.page.next ?? undefined, keyboardActivationSource(event));
              }}
            >
              {m.realm_bans_next()}
            </Button>
          ) : null}
        </>
      )}
      {result?.ok && (view.state === 'ready' || view.state === 'loading' || view.state === 'unavailable') ? (
        <RealmBanOutcome result={result} boundaryId={`${id}-outcome`} />
      ) : null}
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
