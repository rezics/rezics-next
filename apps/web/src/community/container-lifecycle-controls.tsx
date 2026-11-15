import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { safeParse } from 'valibot';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import {
  createContainerLifecycle,
  lifecycleControlsPresentation,
  offeredActions,
  type ContainerLifecycleAdapter,
  type ContainerTarget,
  type LifecycleAction,
  type LifecycleState,
} from './container-lifecycle';
import { readContainerLifecycle, changeContainerLifecycle, readContainerLifecycleDestination } from './space-actions';
import { lifecycleCommandSchema } from './container-lifecycle-native';
import { useCommunityManagementAdmission } from './community-management';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import {
  useDefaultContainerLifecycleCaller,
  useInjectedContainerLifecycleCaller,
  type ContainerLifecycleCallerLifetime,
} from './container-lifecycle-caller-lifetime';

const useLifecycleLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function createLiveLifecycleAdapter(csrfToken: string): ContainerLifecycleAdapter {
  return {
    read: (target, contextId) => readContainerLifecycle({ data: { target, contextId } }),
    change: (intent) => {
      const command = safeParse(lifecycleCommandSchema, intent);
      if (!command.success) return Promise.resolve({ kind: 'refused', status: 400, code: 'invalid_request' });
      return changeContainerLifecycle({
        data: command.output,
        headers: { 'X-CSRF-Token': csrfToken },
      });
    },
    destination: (target, contextId) => readContainerLifecycleDestination({ data: { target, contextId } }),
  };
}

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

type ContainerLifecycleControlsProps = {
  target: ContainerTarget;
  title: string;
  adapter?: ContainerLifecycleAdapter;
  onRestriction?: (restriction: 'removed' | 'orphaned') => void;
};

type Caller = {
  lifetime: ContainerLifecycleCallerLifetime;
  connectionRevision: number;
  ready: boolean;
};

type LifecycleFocusRequest = {
  targetKey: string;
  action: LifecycleAction;
  destination: 'confirmation' | 'action' | 'settlement';
  generation: number;
  control: object;
  callerLifetime: ContainerLifecycleCallerLifetime;
  callerLifetimeId: number;
  connectionRevision: number;
  source: HTMLElement;
  intentKey: string | null;
};

function isFocusDestination(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element &&
    element.isConnected &&
    !(element as HTMLButtonElement).disabled &&
    !element.closest('[hidden], [inert]')
  );
}

/** A lifecycle region has no shadcn equivalent; fields and confirmation use existing shadcn controls. */
function LifecycleControlsView({
  target,
  title,
  adapter,
  caller,
  onRestriction,
}: ContainerLifecycleControlsProps & { adapter: ContainerLifecycleAdapter; caller: Caller }) {
  const id = useId();
  const control = useMemo(
    () => createContainerLifecycle(target, adapter, undefined, caller.lifetime),
    [target.kind, target.id, adapter, caller.lifetime],
  );
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const reasonBaseline = useRef({ control, value: state.reason });
  if (reasonBaseline.current.control !== control) reasonBaseline.current = { control, value: state.reason };
  const [confirmation, setConfirmation] = useState<LifecycleAction | null>(null);
  const actionButtonRefs = useRef(new Map<LifecycleAction, HTMLButtonElement>());
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const resultBoundaryRef = useRef<HTMLElement>(null);
  const readStatusRef = useRef<HTMLParagraphElement>(null);
  const focusRequestRef = useRef<LifecycleFocusRequest | null>(null);
  const focusGenerationRef = useRef(0);
  const [settlementRevision, setSettlementRevision] = useState(0);
  const targetKey = `${target.kind}:${target.id}`;
  const requestFocus = (
    destination: LifecycleFocusRequest['destination'],
    action: LifecycleAction,
    source: HTMLElement,
    intentKey: string | null = null,
  ) => {
    const generation = ++focusGenerationRef.current;
    focusRequestRef.current = {
      targetKey,
      action,
      destination,
      generation,
      control,
      callerLifetime: caller.lifetime,
      callerLifetimeId: caller.lifetime.id,
      connectionRevision: caller.connectionRevision,
      source,
      intentKey,
    };
    return generation;
  };
  useLifecycleLayoutEffect(() => {
    if (state.outcome === 'confirmed' && state.intent?.action === 'remove')
      reasonBaseline.current.value = state.intent.reason;
  }, [control, state.outcome, state.intent]);
  const presentation = lifecycleControlsPresentation(state);
  const visible = useCommunityManagementAdmission(
    target.kind === 'space' ? 'space-lifecycle' : 'realm-lifecycle',
    caller.ready && caller.lifetime.current(),
  );
  const actions = offeredActions(state);
  useEffect(() => {
    setConfirmation(null);
    if (caller.ready && caller.lifetime.current()) void control.refresh();
  }, [control, caller.lifetime, caller.connectionRevision, caller.ready]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cancelSettlementFocus = () => {
      if (focusRequestRef.current?.destination === 'settlement') focusRequestRef.current = null;
    };
    const keepCurrentFocus = (event: FocusEvent) => {
      const request = focusRequestRef.current;
      if (
        !request ||
        event.target === request.source ||
        event.target === document.body ||
        event.target === document.documentElement
      )
        return;
      focusRequestRef.current = null;
    };
    const cancelOnPointer = () => cancelSettlementFocus();
    const cancelOnActivation = (event: Event) => {
      if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key === 'Tab' || key === 'Enter' || key === ' ') cancelSettlementFocus();
      } else cancelSettlementFocus();
    };
    document.addEventListener('focusin', keepCurrentFocus, true);
    document.addEventListener('pointerdown', cancelOnPointer, true);
    document.addEventListener('keydown', cancelOnActivation, true);
    document.addEventListener('click', cancelOnActivation, true);
    return () => {
      document.removeEventListener('focusin', keepCurrentFocus, true);
      document.removeEventListener('pointerdown', cancelOnPointer, true);
      document.removeEventListener('keydown', cancelOnActivation, true);
      document.removeEventListener('click', cancelOnActivation, true);
      focusRequestRef.current = null;
    };
  }, []);
  useLifecycleLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    if (
      request.generation !== focusGenerationRef.current ||
      request.targetKey !== targetKey ||
      request.control !== control ||
      request.callerLifetime !== caller.lifetime ||
      request.callerLifetimeId !== caller.lifetime.id ||
      request.connectionRevision !== caller.connectionRevision ||
      !caller.ready ||
      !caller.lifetime.current() ||
      !visible
    ) {
      focusRequestRef.current = null;
      return;
    }
    const ownerDocument = request.source.ownerDocument;
    const active = ownerDocument.activeElement;
    if (active !== request.source && active !== ownerDocument.body && active !== ownerDocument.documentElement) {
      focusRequestRef.current = null;
      return;
    }
    let destination: HTMLElement | null = null;
    if (request.destination === 'confirmation') {
      if (confirmation === request.action && actions.includes(request.action)) destination = cancelButtonRef.current;
      else if (confirmation !== request.action) {
        focusRequestRef.current = null;
        return;
      } else destination = resultBoundaryRef.current ?? readStatusRef.current;
    } else if (request.destination === 'action') {
      if (confirmation !== null) return;
      const actionButton = actions.includes(request.action)
        ? (actionButtonRefs.current.get(request.action) ?? null)
        : null;
      destination = isFocusDestination(actionButton)
        ? actionButton
        : (resultBoundaryRef.current ?? readStatusRef.current);
    } else {
      const intent = state.intent;
      if (request.intentKey && (intent?.action !== request.action || intent.idempotencyKey !== request.intentKey)) {
        focusRequestRef.current = null;
        return;
      }
      if (state.busy || state.outcome === 'sending') return;
      if (request.intentKey && !['confirmed', 'uncertain', 'conflict', 'refused'].includes(state.outcome)) {
        focusRequestRef.current = null;
        return;
      }
      destination = resultBoundaryRef.current ?? readStatusRef.current;
    }
    if (!isFocusDestination(destination)) {
      focusRequestRef.current = null;
      return;
    }
    focusRequestRef.current = null;
    destination.focus({ preventScroll: true });
  }, [
    targetKey,
    control,
    caller.lifetime,
    caller.lifetime.id,
    caller.connectionRevision,
    caller.ready,
    visible,
    confirmation,
    actions,
    state.intent,
    state.busy,
    state.outcome,
    settlementRevision,
  ]);
  useEffect(() => {
    if (
      state.read.kind !== 'ready' ||
      state.read.snapshot.state === 'orphaned' ||
      (confirmation && !state.read.snapshot.actions.includes(confirmation))
    )
      setConfirmation(null);
  }, [state.read, confirmation]);
  useEffect(() => {
    if (!caller.ready || !caller.lifetime.current()) return;
    if (state.outcome === 'confirmed' && state.intent?.action === 'remove') onRestriction?.('removed');
    else if (state.read.kind === 'ready' && state.read.snapshot.state !== 'active')
      onRestriction?.(state.read.snapshot.state);
  }, [state, onRestriction, caller.lifetime, caller.connectionRevision, caller.ready]);
  const readOnly =
    state.read.kind === 'ready' && state.read.snapshot.actions.length === 0 && !presentation.canRetry;
  const problem = state.problem ?? (state.read.kind === 'refused' ? state.read : null);
  const locked = state.busy || state.intent !== null;
  const showFreshActions = state.outcome === 'none' && actions.length > 0;
  const reasonCanBeSubmitted =
    showFreshActions &&
    state.read.kind === 'ready' &&
    state.read.snapshot.state === 'active' &&
    state.read.snapshot.actions.includes('remove');
  const changedReason = state.reason !== reasonBaseline.current.value;
  const reasonDraft = changedReason && (state.read.kind !== 'ready' || reasonCanBeSubmitted);
  const showRetainedReason =
    Boolean(state.reason) &&
    !reasonCanBeSubmitted &&
    (state.intent?.action === 'remove' ||
      (state.intent === null && (state.read.kind !== 'ready' || state.read.snapshot.state === 'active')));
  const reviewedConfirmation =
    showFreshActions &&
    confirmation !== null &&
    state.read.kind === 'ready' &&
    state.read.snapshot.state !== 'orphaned' &&
    state.read.snapshot.actions.includes(confirmation);
  const unresolvedIntent = state.intent !== null && (state.outcome === 'sending' || state.outcome === 'uncertain');
  const acknowledgement = state.outcome === 'confirmed' ? (state.intent?.idempotencyKey ?? '') : '';
  const reviewAvailable =
    !state.busy &&
    state.reviewed &&
    state.read.kind === 'ready' &&
    (state.outcome === 'refused' || state.outcome === 'conflict' || state.outcome === 'confirmed');
  const departureActive = caller.ready && caller.lifetime.current();
  useAuthoringDeparture(
    departureActive && (reasonDraft || reviewedConfirmation || unresolvedIntent),
    departureActive && unresolvedIntent,
    JSON.stringify([target.kind, target.id, caller.lifetime.id, acknowledgement]),
    undefined,
    caller.lifetime.retire,
    'container-lifecycle',
    {
      title: m.container_lifecycle_leave_title(),
      unsaved: m.container_lifecycle_leave_unsaved(),
      pending: m.container_lifecycle_leave_pending(),
    },
  );
  if (!visible || !caller.ready || !caller.lifetime.current()) return null;
  return (
    <section aria-labelledby={`${id}-heading`}>
      <ContentItemFrame as="div" data-slot="content-item-frame" className="w-full min-w-0 space-y-5 p-5 sm:p-6">
        <header className="min-w-0 space-y-3">
          <div className="min-w-0 space-y-1">
            <ContentItemHeading level={2} id={`${id}-heading`} className="text-lg font-semibold">
              {target.kind === 'realm' ? m.container_lifecycle_realm() : m.container_lifecycle_space()}
            </ContentItemHeading>
            <p className="min-w-0 text-lg font-medium [overflow-wrap:anywhere]">{title}</p>
          </div>
          <div className="min-w-0 space-y-2 rounded-xl border bg-muted/40 p-4">
            <p ref={readStatusRef} tabIndex={-1} role="status" className="text-sm font-medium [overflow-wrap:anywhere]">
              {readMessage(state)}
            </p>
            {readOnly ? <p className="text-sm text-muted-foreground">{m.container_lifecycle_read_only()}</p> : null}
          </div>
        </header>
        {state.outcome !== 'none' || problem ? (
          <div
            ref={(element) => {
              resultBoundaryRef.current = element;
            }}
            tabIndex={-1}
            className="min-w-0 space-y-3"
          >
            {state.outcome === 'sending' && state.intent ? (
              <div role="status" className="space-y-1 rounded-xl bg-muted p-4 text-sm">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {state.intent.action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore()} ·{' '}
                  {title}
                </p>
                <p>{m.container_lifecycle_working()}</p>
              </div>
            ) : null}
            {state.outcome === 'confirmed' ? (
              <div role="status" className="space-y-2 rounded-xl bg-muted p-4 text-sm">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {state.intent?.action === 'remove' ? m.container_lifecycle_removed() : m.container_lifecycle_restored()}
                </p>
                {state.intent?.action === 'restore' ? (
                  state.destination ? (
                    <a
                      href={state.destination}
                      className="inline-flex items-center whitespace-normal font-medium underline underline-offset-4 [overflow-wrap:anywhere]"
                    >
                      {m.container_lifecycle_open()}
                    </a>
                  ) : (
                    <p className="[overflow-wrap:anywhere]">{m.container_lifecycle_link_unavailable()}</p>
                  )
                ) : null}
              </div>
            ) : null}
            {state.outcome === 'uncertain' ? (
              <div role="alert" className="space-y-1 rounded-xl border border-border p-4 text-sm">
                {state.intent ? (
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {state.intent.action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore()} ·{' '}
                    {title}
                  </p>
                ) : null}
                <p>{m.container_lifecycle_uncertain()}</p>
              </div>
            ) : null}
            {state.outcome === 'conflict' ? (
              <div role="alert" className="space-y-1 rounded-xl border border-border p-4 text-sm">
                {state.intent ? (
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {state.intent.action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore()} ·{' '}
                    {title}
                  </p>
                ) : null}
                <p>{m.container_lifecycle_conflict()}</p>
              </div>
            ) : null}
            {problem ? (
              <div className="min-w-0 space-y-2 text-sm">
                {state.outcome !== 'conflict' ? <p role="alert">{m.container_lifecycle_refused()}</p> : null}
                <details className="min-w-0">
                  <summary className="cursor-pointer font-medium underline underline-offset-4">
                    {m.community_management_details_problem_summary()}
                  </summary>
                  <dl className="grid min-w-0 gap-2 pt-2 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                      <dt className="text-muted-foreground">{m.community_management_details_status()}</dt>
                      <dd className="select-all font-mono">{problem.status}</dd>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <dt className="text-muted-foreground">{m.community_management_details_code()}</dt>
                      <dd className="select-all break-all font-mono">{problem.code}</dd>
                    </div>
                    {problem.detail ? (
                      <div className="min-w-0 space-y-1 sm:col-span-2">
                        <dt className="text-muted-foreground">{m.community_management_details_explanation()}</dt>
                        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{problem.detail}</dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
              </div>
            ) : null}
          </div>
        ) : null}
        {presentation.canRetry ? (
          <div className="space-y-2 rounded-xl border p-4">
            {state.intent ? (
              <p className="text-sm font-medium [overflow-wrap:anywhere]">
                {state.intent.action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore()} · {title}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button className="whitespace-normal [overflow-wrap:anywhere]" onClick={() => void control.retry()}>
                {m.container_lifecycle_retry()}
              </Button>
            </div>
          </div>
        ) : null}
        {reviewAvailable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              className="whitespace-normal [overflow-wrap:anywhere]"
              variant="outline"
              onClick={() => {
                setConfirmation(null);
                control.review();
              }}
            >
              {m.container_lifecycle_review()}
            </Button>
          </div>
        ) : null}
        {showFreshActions ? (
          <div className="min-w-0 space-y-4 rounded-xl border p-4">
            {actions.includes('remove') ? (
              <Field>
                <FieldLabel htmlFor={`${id}-reason`}>{m.container_lifecycle_reason()}</FieldLabel>
                <Textarea
                  id={`${id}-reason`}
                  className="min-w-0 [overflow-wrap:anywhere]"
                  value={state.reason}
                  readOnly={locked || !reasonCanBeSubmitted}
                  aria-describedby={`${id}-reason-help`}
                  onChange={(event) => control.setReason(event.target.value)}
                />
                <p id={`${id}-reason-help`} className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {m.container_lifecycle_reason_help()}
                </p>
              </Field>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action}
                  className="whitespace-normal [overflow-wrap:anywhere]"
                  ref={(element) => {
                    if (element) actionButtonRefs.current.set(action, element);
                    else actionButtonRefs.current.delete(action);
                  }}
                  variant={action === 'remove' ? 'destructive' : 'default'}
                  disabled={action === 'remove' && !state.reason.trim()}
                  onClick={(event) => {
                    requestFocus('confirmation', action, event.currentTarget);
                    setConfirmation(action);
                  }}
                >
                  {action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore()}
                </Button>
              ))}
            </div>
            {reviewedConfirmation ? (
              <div role="group" aria-labelledby={`${id}-confirm`} className="space-y-3 rounded-xl bg-muted p-4">
                <p id={`${id}-confirm`} className="text-sm [overflow-wrap:anywhere]">
                  {confirmation === 'remove'
                    ? m.container_lifecycle_confirm_remove({ title })
                    : m.container_lifecycle_confirm_restore({ title })}
                </p>
                <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {target.kind === 'realm' ? m.container_lifecycle_realm() : m.container_lifecycle_space()} ·{' '}
                  <code className="break-all font-mono">{target.id}</code>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="whitespace-normal [overflow-wrap:anywhere]"
                    variant={confirmation === 'remove' ? 'destructive' : 'default'}
                    onClick={(event) => {
                      const action = confirmation;
                      const previousIntentKey = control.getSnapshot().intent?.idempotencyKey;
                      const generation =
                        event.detail === 0 ? requestFocus('settlement', action, event.currentTarget) : null;
                      setConfirmation(null);
                      const submission = control.submit(action);
                      const intent = control.getSnapshot().intent;
                      if (
                        generation !== null &&
                        focusRequestRef.current?.generation === generation &&
                        intent?.action === action &&
                        intent.idempotencyKey !== previousIntentKey
                      )
                        focusRequestRef.current.intentKey = intent.idempotencyKey;
                      void submission.then(() => {
                        if (generation !== null && focusRequestRef.current?.generation === generation)
                          setSettlementRevision((revision) => revision + 1);
                      });
                    }}
                  >
                    {m.container_lifecycle_confirm()}
                  </Button>
                  <Button
                    className="whitespace-normal [overflow-wrap:anywhere]"
                    ref={cancelButtonRef}
                    variant="outline"
                    onClick={(event) => {
                      requestFocus('action', confirmation, event.currentTarget);
                      setConfirmation(null);
                    }}
                  >
                    {m.container_lifecycle_cancel()}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {showRetainedReason ? (
          <details className="min-w-0">
            <summary className="cursor-pointer font-medium underline underline-offset-4">
              {m.container_lifecycle_reason()}
            </summary>
            <div className="pt-2">
              <Field>
                <FieldLabel htmlFor={`${id}-reason`}>{m.container_lifecycle_reason()}</FieldLabel>
                <Textarea
                  id={`${id}-reason`}
                  className="min-w-0 [overflow-wrap:anywhere]"
                  value={state.reason}
                  readOnly
                  aria-describedby={`${id}-reason-help`}
                />
                <p id={`${id}-reason-help`} className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {m.container_lifecycle_reason_help()}
                </p>
              </Field>
            </div>
          </details>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button
            className="whitespace-normal [overflow-wrap:anywhere]"
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
      </ContentItemFrame>
    </section>
  );
}

function DefaultLifecycleControls(props: ContainerLifecycleControlsProps) {
  const caller = useDefaultContainerLifecycleCaller(props.target);
  const adapter = useMemo(
    () => createLiveLifecycleAdapter(caller.csrfToken ?? ''),
    [caller.lifetime, caller.csrfToken],
  );
  return <LifecycleControlsView {...props} adapter={adapter} caller={caller} />;
}

function InjectedLifecycleControls(props: ContainerLifecycleControlsProps & { adapter: ContainerLifecycleAdapter }) {
  const caller = useInjectedContainerLifecycleCaller(props.target, props.adapter);
  return <LifecycleControlsView {...props} caller={caller} />;
}

/** Default callers bind credentials and cache revision; injected adapters keep their isolated fixture contract. */
export function ContainerLifecycleControls(props: ContainerLifecycleControlsProps) {
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      {props.adapter ? (
        <InjectedLifecycleControls {...props} adapter={props.adapter} />
      ) : (
        <DefaultLifecycleControls {...props} />
      )}
    </AuthoringDepartureBoundary>
  );
}

/** Session presence allows preparation only; it conveys no lifecycle permission. */
export function ContainerLifecyclePanel(props: ContainerLifecycleControlsProps) {
  const { state, subject } = useSession();
  return state === 'signed-in' && subject ? (
    <ContainerLifecycleControls key={`${props.target.kind}:${props.target.id}:${subject}`} {...props} />
  ) : null;
}
