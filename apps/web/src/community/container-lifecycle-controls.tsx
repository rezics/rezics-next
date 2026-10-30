import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import {
  createContainerLifecycle,
  mayRetryLifecycle,
  offeredActions,
  unavailableLifecycleAdapter,
  type ContainerLifecycleAdapter,
  type ContainerTarget,
  type LifecycleAction,
  type LifecycleState,
} from './container-lifecycle';

function readMessage(state: LifecycleState) {
  if (state.read.kind === 'loading') return m.container_lifecycle_loading();
  if (state.read.kind !== 'ready') return m.container_lifecycle_unavailable();
  switch (state.read.snapshot.state) {
    case 'active':
      return m.container_lifecycle_active();
    case 'removed':
      return m.container_lifecycle_removed_state();
    case 'orphaned':
      return m.container_lifecycle_orphaned();
  }
}

/** A lifecycle region has no shadcn equivalent; fields and confirmation use existing shadcn controls. */
export function ContainerLifecycleControls({
  target,
  title,
  adapter = unavailableLifecycleAdapter,
  onRestriction,
}: {
  target: ContainerTarget;
  title: string;
  adapter?: ContainerLifecycleAdapter;
  onRestriction?: (restriction: 'removed' | 'orphaned') => void;
}) {
  const id = useId();
  const control = useMemo(() => createContainerLifecycle(target, adapter), [target.kind, target.id, adapter]);
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const [confirmation, setConfirmation] = useState<LifecycleAction | null>(null);
  useEffect(() => {
    setConfirmation(null);
    void control.refresh();
  }, [control]);
  useEffect(() => {
    if (state.outcome === 'confirmed' && state.intent?.action === 'remove') onRestriction?.('removed');
    else if (state.read.kind === 'ready' && state.read.snapshot.state !== 'active')
      onRestriction?.(state.read.snapshot.state);
  }, [state, onRestriction]);
  const actions = offeredActions(state);
  const readOnly =
    state.read.kind === 'ready' && state.read.snapshot.state !== 'orphaned' && state.read.snapshot.actions.length === 0;
  const problem = state.problem ?? (state.read.kind === 'refused' ? state.read : null);
  const locked = state.busy || state.intent !== null;
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4 rounded-2xl border bg-card p-5 sm:p-6">
      <header className="space-y-1">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          {target.kind === 'realm' ? m.container_lifecycle_realm() : m.container_lifecycle_space()}
        </h2>
        <p className="font-medium break-words">{title}</p>
        <p role="status" className="text-sm text-muted-foreground">
          {readMessage(state)}
        </p>
      </header>
      {readOnly ? <p className="text-sm text-muted-foreground">{m.container_lifecycle_read_only()}</p> : null}
      {actions.includes('remove') || state.reason || state.intent?.action === 'remove' ? (
        <Field>
          <FieldLabel htmlFor={`${id}-reason`}>{m.container_lifecycle_reason()}</FieldLabel>
          <Textarea
            id={`${id}-reason`}
            value={state.reason}
            readOnly={locked}
            aria-describedby={`${id}-reason-help`}
            onChange={(event) => control.setReason(event.target.value)}
          />
          <p id={`${id}-reason-help`} className="text-sm text-muted-foreground">
            {m.container_lifecycle_reason_help()}
          </p>
        </Field>
      ) : null}
      {state.outcome === 'confirmed' ? (
        <div role="status" className="space-y-2 rounded-xl bg-muted p-4 text-sm">
          <p>
            {state.intent?.action === 'remove' ? m.container_lifecycle_removed() : m.container_lifecycle_restored()}
          </p>
          {state.intent?.action === 'restore' ? (
            state.destination ? (
              <a href={state.destination} className="font-medium underline underline-offset-4">
                {m.container_lifecycle_open()}
              </a>
            ) : (
              <p>{m.container_lifecycle_link_unavailable()}</p>
            )
          ) : null}
        </div>
      ) : null}
      {state.outcome === 'uncertain' ? (
        <p role="alert" className="text-sm">
          {m.container_lifecycle_uncertain()}
        </p>
      ) : null}
      {state.outcome === 'conflict' ? (
        <p role="alert" className="text-sm">
          {m.container_lifecycle_conflict()}
        </p>
      ) : null}
      {problem ? (
        <div role="alert" className="space-y-1 text-sm">
          <p>{m.container_lifecycle_refused({ status: String(problem.status), code: problem.code })}</p>
          {problem.detail ? <p className="whitespace-pre-wrap break-words">{problem.detail}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === 'remove' ? 'destructive' : 'default'}
            disabled={action === 'remove' && !state.reason.trim()}
            onClick={() => setConfirmation(action)}
          >
            {action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore()}
          </Button>
        ))}
        {mayRetryLifecycle(state) ? (
          <Button onClick={() => void control.retry()}>{m.container_lifecycle_retry()}</Button>
        ) : null}
        {!state.busy &&
        state.reviewed &&
        state.read.kind === 'ready' &&
        (state.outcome === 'refused' || state.outcome === 'conflict' || state.outcome === 'confirmed') ? (
          <Button
            variant="outline"
            onClick={() => {
              setConfirmation(null);
              control.review();
            }}
          >
            {m.container_lifecycle_review()}
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={state.busy}
          onClick={() => {
            setConfirmation(null);
            void control.refresh();
          }}
        >
          {state.busy ? m.container_lifecycle_working() : m.container_lifecycle_refresh()}
        </Button>
      </div>
      {confirmation && actions.includes(confirmation) ? (
        <div role="group" aria-labelledby={`${id}-confirm`} className="space-y-3 rounded-xl bg-muted p-4">
          <p id={`${id}-confirm`} className="text-sm">
            {confirmation === 'remove'
              ? m.container_lifecycle_confirm_remove({ title })
              : m.container_lifecycle_confirm_restore({ title })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={confirmation === 'remove' ? 'destructive' : 'default'}
              onClick={() => {
                const action = confirmation;
                setConfirmation(null);
                void control.submit(action);
              }}
            >
              {m.container_lifecycle_confirm()}
            </Button>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              {m.container_lifecycle_cancel()}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Session presence allows preparation only; it conveys no lifecycle permission. */
export function ContainerLifecyclePanel(props: Parameters<typeof ContainerLifecycleControls>[0]) {
  const { state } = useSession();
  return state === 'signed-in' ? <ContainerLifecycleControls {...props} /> : null;
}
