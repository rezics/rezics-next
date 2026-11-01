import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { EllipsisIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { FollowState, FollowWriteInput, FollowWriteResult } from './follow-records';

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
};

/** The same presenter serves a target button and a Following row's responsive menu. */
export function FollowControl(props: FollowControlProps) {
  return <FollowControlState key={props.targetId} {...props} />;
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
}: FollowControlProps) {
  const [current, setCurrent] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Exclude<FollowWriteResult, { ok: true }>['reason'] | null>(null);
  const [removed, setRemoved] = useState(false);
  const attempt = useRef<FollowWriteInput | null>(null);
  const conflict = useRef(false);
  const inFlight = useRef<{ input: FollowWriteInput } | null>(null);
  const committed = useRef<Pick<FollowControlProps, 'ready' | 'canFollow' | 'canRemove' | 'write' | 'onChange'> | null>(
    null,
  );
  const signedOut = initial.state === 'signed-out';
  // Callback identities may refresh without starting a new request lifetime.
  useLayoutEffect(() => {
    committed.current = { ready: ready && !signedOut, canFollow, canRemove, write, ...(onChange ? { onChange } : {}) };
    const running = inFlight.current;
    if (running && (!ready || signedOut || !(running.input.following ? canFollow : canRemove))) {
      // The dispatched intent remains uncertain; only its retired completion loses authority.
      inFlight.current = null;
      setPending(false);
      setFailure('unavailable');
    }
  });
  useLayoutEffect(
    () => () => {
      committed.current = null;
      inFlight.current = null;
    },
    [],
  );
  const following = initial.state === 'ready' ? initial.following : undefined;
  useEffect(() => {
    if (attempt.current) return;
    setCurrent((previous) => (initial.state !== 'ready' && previous.state === 'ready' ? previous : initial));
  }, [initial.state, following]);
  const action = signedOut
    ? null
    : attempt.current
      ? attempt.current.following
        ? canFollow
          ? 'follow'
          : null
        : canRemove
          ? 'remove'
          : null
      : followAction(current, canFollow, canRemove);
  const disabled = !ready || pending || failure === 'conflict';
  async function submit() {
    const live = committed.current;
    if (!live?.ready || disabled || conflict.current || inFlight.current || !action) return;
    const input = attempt.current ?? {
      targetId,
      following: action === 'follow',
      idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    };
    if (!(input.following ? live.canFollow : live.canRemove)) return;
    const running = { input };
    inFlight.current = running;
    attempt.current = input;
    setPending(true);
    setFailure(null);
    if (current.state === 'pending') setCurrent({ state: 'unavailable' });
    let result: FollowWriteResult;
    try {
      result = await live.write(input);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (inFlight.current !== running) return;
    try {
      if (result.ok) {
        attempt.current = null;
        setCurrent({ state: 'ready', following: result.following });
        setRemoved(!result.following);
        committed.current?.onChange?.(result.following);
      } else {
        conflict.current = result.reason === 'conflict';
        setFailure(result.reason);
      }
    } finally {
      if (inFlight.current === running) {
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
    <div data-slot="follow-control" className="flex min-w-0 flex-wrap items-center gap-2" aria-busy={pending}>
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
      {onRetry && current.state !== 'ready' && current.state !== 'pending' ? (
        <Button type="button" variant="ghost" disabled={pending} onClick={onRetry}>
          {m.library_follow_retry()}
        </Button>
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
