import { Menu } from '@rezics/ui/menu';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { EllipsisIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { FollowState, FollowWriteInput, FollowWriteResult } from './follow-records';
import { createFollowIntent } from './mine-following-intent';

/** Removal is independent of create and of the ability to read the target or the own edge. */
export function followAction(state: FollowState, canFollow: boolean, canRemove: boolean): 'follow' | 'remove' | null {
  if (state.state === 'signed-out') return null;
  if (state.state !== 'ready') return canRemove ? 'remove' : null;
  return state.following ? (canRemove ? 'remove' : null) : canFollow ? 'follow' : null;
}

export type FollowControlProps = {
  targetId: string;
  initial: FollowState;
  canFollow: boolean;
  canRemove: boolean;
  ready: boolean;
  write: (input: FollowWriteInput) => Promise<FollowWriteResult>;
  idempotencyKey?: string;
  menuTitle?: string;
  onChange?: (following: boolean) => void;
  onRetry?: () => void;
  /** Explicit, permitted own-edge or current-list review; never a target read or a write. */
  onReview?: () => Promise<FollowState | null>;
  /** Routed controls bind callbacks to actual mounted viewer and directional write admission. */
  isCurrent?: (following: boolean) => boolean;
  readLifetime?: string | null;
  onAccepted?: (following: boolean, input: FollowWriteInput) => boolean;
};

/** The same presenter serves a target button and a Following row's responsive menu. */
export function FollowControl(props: FollowControlProps) {
  const create = () => ({
    targetId: props.targetId,
    active: true,
    mounted: false,
    put: { active: true, allowed: false },
    remove: { active: true, allowed: false },
  });
  const ref = useRef(create());
  if (ref.current.targetId !== props.targetId) {
    ref.current.active = false;
    ref.current = create();
  }
  const origin = ref.current;
  for (const [name, allowed] of [
    ['put', props.ready && props.initial.state !== 'signed-out' && props.canFollow],
    ['remove', props.ready && props.initial.state !== 'signed-out' && props.canRemove],
  ] as const) {
    if (origin[name].allowed !== allowed) {
      origin[name].active = false;
      origin[name] = { active: true, allowed };
    }
  }
  const { put, remove } = origin;
  useLayoutEffect(() => {
    if (origin.active) origin.mounted = true;
    return () => {
      origin.mounted = false;
    };
  }, [origin]);
  return (
    <FollowControlState
      key={props.targetId}
      {...props}
      {...(props.onRetry
        ? {
            onRetry: () => {
              if (origin.active && origin.mounted) props.onRetry?.();
            },
          }
        : {})}
      {...(props.onReview
        ? {
            onReview: async () => {
              if (!origin.active || !origin.mounted) return null;
              const result = await props.onReview?.();
              return origin.active && origin.mounted ? (result ?? null) : null;
            },
          }
        : {})}
      isCurrent={(next) =>
        origin.active &&
        origin.mounted &&
        (next ? put : remove).active &&
        (next ? put : remove).allowed &&
        (props.isCurrent?.(next) ?? true)
      }
    />
  );
}

function FollowControlState({
  targetId,
  initial,
  canFollow,
  canRemove,
  ready,
  write,
  idempotencyKey,
  menuTitle,
  onChange,
  onRetry,
  onReview,
  isCurrent,
  readLifetime,
  onAccepted,
}: FollowControlProps) {
  const [current, setCurrent] = useState(initial);
  const [pendingState, setPending] = useState(false);
  const [failure, setFailure] = useState<Exclude<FollowWriteResult, { ok: true }>['reason'] | null>(null);
  const [removed, setRemoved] = useState(false);
  const intent = useRef(createFollowIntent()).current;
  const conflict = useRef(false);
  const review = useRef<{ readLifetime: FollowControlProps['readLifetime'] } | null>(null);
  const [reviewState, setReviewState] = useState<'idle' | 'pending' | 'failed' | 'ready'>('idle');
  const inFlight = useRef<{
    input: FollowWriteInput;
    isCurrent: FollowControlProps['isCurrent'];
    readLifetime: FollowControlProps['readLifetime'];
    onAccepted: FollowControlProps['onAccepted'];
    onChange: FollowControlProps['onChange'];
  } | null>(null);
  const committed = useRef<Pick<
    FollowControlProps,
    'ready' | 'canFollow' | 'canRemove' | 'write' | 'onChange' | 'isCurrent' | 'readLifetime' | 'onAccepted'
  > | null>(null);
  const signedOut = initial.state === 'signed-out';
  const following = initial.state === 'ready' ? initial.following : undefined;
  const initialKey = JSON.stringify([readLifetime, initial.state, following]);
  const [observed, setObserved] = useState(initialKey);
  if (observed !== initialKey) {
    // Adjust before commit: a retired/unavailable read must never leave a ready frame behind.
    setObserved(initialKey);
    setCurrent(initial);
    setRemoved(false);
  }
  if (review.current && (!onReview || signedOut || review.current.readLifetime !== readLifetime)) {
    review.current = null;
    setReviewState('failed');
  }
  const running = inFlight.current;
  if (
    running &&
    (!ready ||
      signedOut ||
      !(running.input.following ? canFollow : canRemove) ||
      (running.isCurrent && !running.isCurrent(running.input.following)))
  ) {
    inFlight.current = null;
    setPending(false);
    setFailure('unavailable');
  }
  // Callback identities may refresh without starting a new request lifetime.
  useLayoutEffect(() => {
    committed.current = {
      ready: ready && !signedOut,
      canFollow,
      canRemove,
      write,
      ...(readLifetime !== undefined ? { readLifetime } : {}),
      ...(onChange ? { onChange } : {}),
      ...(isCurrent ? { isCurrent } : {}),
      ...(onAccepted ? { onAccepted } : {}),
    };
  });
  useLayoutEffect(
    () => () => {
      committed.current = null;
      inFlight.current = null;
      review.current = null;
    },
    [],
  );
  const pending = pendingState && inFlight.current !== null;
  const action = signedOut
    ? null
    : intent.current
      ? intent.current.following
        ? canFollow
          ? 'follow'
          : null
        : canRemove
          ? 'remove'
          : null
      : followAction(current, canFollow, canRemove);
  const reviewing = reviewState === 'pending';
  const disabled = !ready || pending || conflict.current || reviewing;
  function recover(input: FollowWriteInput, edge: FollowState) {
    if (!committed.current || !conflict.current || intent.current !== input) return;
    intent.reject(input);
    conflict.current = false;
    setFailure(null);
    setCurrent(edge);
    setRemoved(false);
  }
  async function reviewConflict() {
    const input = intent.current;
    if (!input || !conflict.current || !onReview || review.current) return;
    const request = { readLifetime };
    review.current = request;
    setReviewState('pending');
    let edge: FollowState | null = null;
    try {
      edge = await onReview();
    } catch {
      // Failed review leaves the rejected command locked; it supplies no edge knowledge.
    }
    if (review.current !== request || !committed.current) return;
    review.current = null;
    if (edge?.state === 'ready') {
      recover(input, edge);
      setReviewState('ready');
    } else setReviewState('failed');
  }
  async function submit() {
    const live = committed.current;
    if (!live?.ready || disabled || conflict.current || inFlight.current || !action) return;
    const next = intent.current?.following ?? action === 'follow';
    if (
      !(next ? live.canFollow : live.canRemove) ||
      (isCurrent && !isCurrent(next)) ||
      (live.isCurrent && !live.isCurrent(next))
    )
      return;
    const input = intent.begin(targetId, next, idempotencyKey);
    const running = {
      input,
      isCurrent: live.isCurrent,
      readLifetime: live.readLifetime,
      onAccepted: live.onAccepted,
      onChange: live.onChange,
    };
    inFlight.current = running;
    setPending(true);
    setFailure(null);
    setReviewState('idle');
    if (current.state === 'pending') setCurrent({ state: 'unavailable' });
    let result: FollowWriteResult;
    try {
      result = await live.write(input);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (inFlight.current !== running || (running.isCurrent && !running.isCurrent(input.following))) return;
    try {
      if (result.ok) {
        intent.confirm(input);
        const accepted = running.onAccepted?.(result.following, input) ?? true;
        if (running.isCurrent && !running.isCurrent(input.following)) return;
        if (accepted && committed.current?.readLifetime === running.readLifetime) {
          setCurrent({ state: 'ready', following: result.following });
          setRemoved(!result.following);
        }
        if (!running.onAccepted) running.onChange?.(result.following);
      } else {
        conflict.current = result.reason === 'conflict';
        setFailure(result.reason);
      }
    } finally {
      if (inFlight.current === running && (!running.isCurrent || running.isCurrent(input.following))) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }
  const label = action === 'follow' ? m.library_follow() : m.library_follow_unfollow();
  const error =
    failure === 'conflict'
      ? m.library_follow_conflict()
      : failure === 'forbidden' || failure === 'unauthorized' || failure === 'closed'
        ? m.library_follow_forbidden()
        : failure
          ? m.error_message()
          : '';
  return (
    <div
      data-slot="follow-control"
      className="flex min-w-0 flex-wrap items-center gap-2"
      aria-busy={pending || reviewing}
    >
      {current.state === 'ready' && current.following && !menuTitle ? (
        <span className="text-sm text-muted-foreground">{m.library_following()}</span>
      ) : null}
      {action ? (
        menuTitle ? (
          <Menu
            title={menuTitle}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={menuTitle} disabled={disabled}>
                <EllipsisIcon aria-hidden="true" />
              </Button>
            }
            entries={[{ type: 'item', label, disabled, onSelect: () => void submit() }]}
          />
        ) : (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => void submit()}>
            {label}
          </Button>
        )
      ) : null}
      {pending ? (
        <p role="status" className="text-sm">
          {m.library_follow_pending()}
        </p>
      ) : current.state === 'pending' ? (
        <p role="status" className="text-sm">
          {m.library_follow_loading()}
        </p>
      ) : null}
      {current.state !== 'ready' && current.state !== 'pending' && current.state !== 'signed-out' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_follow_unavailable()}
        </p>
      ) : null}
      {conflict.current ? (
        <>
          {onReview ? (
            <Button type="button" variant="ghost" disabled={reviewing} onClick={() => void reviewConflict()}>
              {m.library_follow_conflict_recovery_review()}
            </Button>
          ) : null}
          {!onReview || reviewState === 'failed' ? (
            <>
              <p role="status" className="text-sm text-muted-foreground">
                {m.library_follow_conflict_recovery_unavailable()}
              </p>
              {canRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={reviewing}
                  onClick={() => {
                    if (intent.current) recover(intent.current, { state: 'unavailable' });
                    setReviewState('idle');
                  }}
                >
                  {m.library_follow_conflict_recovery_remove()}
                </Button>
              ) : (
                <a href="" className={buttonVariants({ variant: 'ghost' })}>
                  {m.library_follow_conflict_recovery_reload()}
                </a>
              )}
            </>
          ) : null}
        </>
      ) : onRetry && current.state !== 'ready' && current.state !== 'pending' ? (
        <Button type="button" variant="ghost" disabled={pending} onClick={onRetry}>
          {m.library_follow_retry()}
        </Button>
      ) : null}
      {reviewState === 'ready' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_follow_conflict_recovery_ready()}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
      {removed ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_follow_removed()}
        </p>
      ) : null}
    </div>
  );
}
