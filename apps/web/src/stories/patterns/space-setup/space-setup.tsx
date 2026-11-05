import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Check, ArrowRight, ArrowLeft, MapPin, Users, LayoutList, MessageSquare } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { m } from '../../../paraglide/messages.js';
import {
  AuthoringDepartureProvider,
  useAuthoringDeparture,
  type AuthoringLocation,
} from '../../../threads/authoring-departure';
import { SetupBoardPicker } from '../../../community/setup-board-picker-control';
import {
  currentBoardConcept,
  unavailableBoardChoiceSource,
  type BoardChoiceSource,
  type BoardConceptSelection,
} from '../../../community/setup-board-picker';
import { SetupContextPickerField } from '../../../community/setup-context-picker-field';
import {
  createSetupContextPicker,
  unavailableContextChoiceSource,
  type ContextChoiceSource,
} from '../../../community/setup-context-picker';
import {
  applySetupResult,
  setupAttempt,
  retainSetupAttempt,
  type SetupSnapshot,
  type SetupFailure,
  type SetupCommand,
  type SetupDraftCommand,
  type SetupChoice,
  type SetupResult,
} from '../../../community/space-setup';
import {
  SpaceSetupCallerLifetimeContext,
  standaloneSpaceSetupLifetime,
  type SpaceSetupCallerLifetime,
} from '../../../community/space-setup-lifetime';

const useCallerLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
// Router locations already carry the route's validated Space target. Picker searches and steps are local work.
const setupNavigationContext = ({ pathname, search }: AuthoringLocation) =>
  JSON.stringify([pathname, typeof search.spaceId === 'string' ? search.spaceId : null]);

export type SetupTransport = {
  contexts?: ContextChoiceSource;
  command(command: SetupCommand): Promise<SetupResult>;
  read(spaceId?: string): Promise<SetupSnapshot | SetupFailure>;
  choice(kind: 'context' | 'scheme' | 'concept', id: string): Promise<SetupChoice | SetupFailure>;
};
export const emptySetup: SetupSnapshot = {
  kind: 'ready',
  space: null,
  realm: null,
  permitted: { address: false, settings: false, scheme: false, board: false },
};

function problemText(problem: SetupFailure) {
  return problem.reason === 'conflict'
    ? m.space_setup_conflict()
    : problem.reason === 'denied'
      ? m.space_setup_denied()
      : problem.reason === 'invalid'
        ? m.space_setup_invalid()
        : m.space_setup_unavailable();
}
function SetupDetails({ children }: { children: ReactNode }) {
  return (
    <details className="min-w-0 text-sm text-muted-foreground">
      <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.space_setup_details_heading()}
      </summary>
      <p className="mt-2 leading-relaxed">{children}</p>
    </details>
  );
}
function TextField({
  label,
  value,
  onChange,
  maxLength = 1024,
  multiline = false,
  description,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength?: number;
  multiline?: boolean;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    value,
    maxLength,
    required: !multiline,
    disabled,
    'aria-describedby': description ? `${id}-hint` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? <Textarea {...props} /> : <Input {...props} />}
      {description ? <FieldDescription id={`${id}-hint`}>{description}</FieldDescription> : null}
    </Field>
  );
}
function SelectField({
  label,
  value,
  onChange,
  children,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      >
        {children}
      </NativeSelect>
    </Field>
  );
}
function Choice({
  kind,
  label,
  value,
  onChange,
  transport,
  disabled,
  reference: text,
  onReferenceChange: setText,
}: {
  kind: 'context' | 'scheme' | 'concept';
  label: string;
  value: SetupChoice | null;
  onChange(value: SetupChoice | null): void;
  transport: SetupTransport;
  disabled: boolean;
  reference: string;
  onReferenceChange(value: string): void;
}) {
  const generation = useRef(0);
  const mounted = useRef(false);
  const intent = useRef({ transport, kind, text });
  intent.current = { transport, kind, text };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SetupFailure | null>(null);
  const id = useId();
  async function resolve() {
    if (disabled || !mounted.current) return;
    const request = ++generation.current;
    const requestIntent = { transport, kind, text };
    const current = () =>
      mounted.current &&
      generation.current === request &&
      intent.current.transport === requestIntent.transport &&
      intent.current.kind === requestIntent.kind &&
      intent.current.text === requestIntent.text;
    setBusy(true);
    setProblem(null);
    try {
      const result = await transport.choice(kind, text.trim());
      if (!current()) return;
      if ('kind' in result) setProblem(result);
      else onChange(result);
    } catch {
      if (current()) setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {value ? (
        <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 break-words font-medium">{value.label}</span>
        </div>
      ) : (
        <FieldDescription>{m.space_setup_picker_unavailable()}</FieldDescription>
      )}
      <details className="rounded-xl border border-border p-3" open={value ? undefined : true}>
        <summary className="cursor-pointer text-sm font-medium">{m.space_setup_load_existing()}</summary>
        <div className="mt-3 space-y-3">
          <FieldDescription id={`${id}-hint`}>{m.space_setup_reference_hint()}</FieldDescription>
          <label htmlFor={id} className="text-sm">
            {m.space_setup_reference()}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={id}
              value={text}
              maxLength={36}
              aria-describedby={`${id}-hint`}
              className="min-w-0 flex-1 basis-48"
              disabled={disabled || busy}
              onChange={(e) => {
                generation.current++;
                setBusy(false);
                setText(e.target.value);
                onChange(null);
                setProblem(null);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={
                disabled ||
                busy ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text.trim())
              }
              onClick={() => void resolve()}
            >
              {busy ? m.space_setup_loading() : m.space_setup_resolve()}
            </Button>
          </div>
        </div>
      </details>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problemText(problem)}
        </p>
      ) : null}
    </Field>
  );
}

/**
 * Composes shadcn controls into a setup journey, which has no shadcn equivalent.
 * One command at a time; draft values live independently of refreshed authoritative heads.
 */
type SpaceSetupFormProps = {
  initial: SetupSnapshot | SetupFailure;
  transport: SetupTransport;
  boardChoices?: BoardChoiceSource;
};
type StepFocusActivation = { source: HTMLElement; generation: number; pointer: number };
type StepFocusIntent = StepFocusActivation & { ticket: number; operation: number; step: number | null };

export function SpaceSetupForm({
  initial,
  transport,
  boardChoices = unavailableBoardChoiceSource,
}: SpaceSetupFormProps) {
  const inherited = useContext(SpaceSetupCallerLifetimeContext);
  const initialIdentity = JSON.stringify(initial);
  const standalone = useMemo(() => standaloneSpaceSetupLifetime(), [initialIdentity, transport, boardChoices]);
  const caller = inherited ?? standalone;
  return (
    <AuthoringDepartureProvider
      key={caller.id}
      navigationContext={setupNavigationContext}
      onNavigationLeave={() => caller.retire()}
      navigationMessages={{
        title: m.space_setup_leave_title(),
        unsaved: m.space_setup_leave_unsaved(),
        pending: m.space_setup_leave_pending(),
      }}
    >
      <SpaceSetupFormVisit initial={initial} transport={transport} boardChoices={boardChoices} caller={caller} />
    </AuthoringDepartureProvider>
  );
}

function SpaceSetupFormVisit({
  initial,
  transport,
  boardChoices = unavailableBoardChoiceSource,
  caller,
}: SpaceSetupFormProps & { caller: SpaceSetupCallerLifetime }) {
  const callerRevision = useSyncExternalStore(caller.subscribe, caller.snapshot, caller.snapshot);
  void callerRevision;
  useCallerLayoutEffect(() => caller.connect(), [caller]);
  const [snapshot, setSnapshot] = useState(initial.kind === 'ready' ? initial : emptySetup);
  const [problem, setProblem] = useState<SetupFailure | null>(initial.kind === 'failure' ? initial : null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(initial.kind === 'ready');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [pending, setPending] = useState<SetupCommand | null>(null);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const inFlight = useRef(false);
  const operation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusGeneration = useRef(0);
  const pointerGeneration = useRef(0);
  const keyboardActivation = useRef<StepFocusActivation | null>(null);
  const focusIntent = useRef<StepFocusIntent | null>(null);
  const focusingHeading = useRef(false);
  const [focusCommit, setFocusCommit] = useState(0);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [acceptedBoard, setAcceptedBoard] = useState<Extract<SetupCommand, { step: 'board' }> | null>(null);
  const [contextReferenceBaseline, setContextReferenceBaseline] = useState(snapshot.realm?.contextId ?? '');
  const [spaceTitle, setSpaceTitle] = useState(snapshot.space?.title ?? '');
  const [spaceSummary, setSpaceSummary] = useState(snapshot.space?.summary ?? '');
  const [address, setAddress] = useState(snapshot.space?.address ?? '');
  const [realmTitle, setRealmTitle] = useState(snapshot.realm?.title ?? '');
  const [realmSummary, setRealmSummary] = useState(snapshot.realm?.summary ?? '');
  const [visibility, setVisibility] = useState<'public' | 'protected'>(snapshot.realm?.visibility ?? 'public');
  const contextSource = useMemo(
    () => transport.contexts ?? unavailableContextChoiceSource((id) => transport.choice('context', id)),
    [transport],
  );
  const contextPicker = useMemo(
    () => createSetupContextPicker(contextSource, snapshot.realm?.contextId),
    [contextSource],
  );
  const contextState = useSyncExternalStore(
    contextPicker.subscribe,
    contextPicker.getSnapshot,
    contextPicker.getSnapshot,
  );
  const context = contextState.selected?.phase === 'ready' ? contextState.selected.choice : null;
  const contextSelectionVersion = contextPicker.selectionVersion();
  useCallerLayoutEffect(() => contextPicker.connect(), [contextPicker]);
  useCallerLayoutEffect(() => {
    void contextPicker.current(snapshot.realm?.contextId ?? null, snapshot.realm?.head);
  }, [contextPicker, snapshot.realm?.contextId, snapshot.realm?.head]);
  const [schemeSelection, setSchemeSelection] = useState<{
    source: BoardChoiceSource;
    choice: SetupChoice;
  } | null>(null);
  const scheme = schemeSelection && schemeSelection.source === boardChoices ? schemeSelection.choice : null;
  const [conceptSelection, setConceptSelection] = useState<
    (BoardConceptSelection & { source: BoardChoiceSource }) | null
  >(null);
  const currentConceptSelection = conceptSelection?.source === boardChoices ? conceptSelection : null;
  const [conceptCleared, setConceptCleared] = useState(false);
  const [boardTitle, setBoardTitle] = useState('');
  const [boardVisibility, setBoardVisibility] = useState<'published' | 'protected' | 'draft'>('published');
  const [purpose, setPurpose] = useState<'discussion' | 'reviews'>('discussion');
  const callerCurrent = caller.current();
  const callerRetired = caller.isRetired();
  const readReady = caller.binding.readReady ?? caller.binding.ready;
  const commandReady = caller.binding.commandReady ?? caller.binding.ready;
  const locked = busy || pending !== null || needsRefresh || !callerCurrent || !readReady;
  function retireStepFocus() {
    focusGeneration.current++;
    keyboardActivation.current = null;
    focusIntent.current = null;
  }
  useEffect(() => {
    const onPointerDown = () => {
      pointerGeneration.current++;
      retireStepFocus();
    };
    const onFocusIn = (event: FocusEvent) => {
      const intent = focusIntent.current ?? keyboardActivation.current;
      if (intent && event.target !== intent.source && event.target !== document.body && !focusingHeading.current)
        retireStepFocus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      retireStepFocus();
    };
  }, []);
  function noteKeyboardActivation(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof HTMLElement)) return;
    const generation = ++focusGeneration.current;
    focusIntent.current = null;
    keyboardActivation.current = { source: event.target, generation, pointer: pointerGeneration.current };
  }
  function currentFocusIntent(intent: StepFocusIntent) {
    return (
      intent.generation === focusGeneration.current &&
      intent.pointer === pointerGeneration.current &&
      intent.operation === operation.current &&
      caller.owns(intent.ticket) &&
      caller.current()
    );
  }
  useCallerLayoutEffect(() => {
    const intent = focusIntent.current;
    if (!intent || intent.step !== step || !currentFocusIntent(intent)) return;
    focusingHeading.current = true;
    heading.current?.focus();
    focusingHeading.current = false;
    focusIntent.current = null;
  }, [caller, callerRevision, focusCommit, step]);
  const { space, realm, permitted } = snapshot;
  const concept = currentBoardConcept(currentConceptSelection, realm?.schemeId ?? null)?.choice ?? null;
  // Each resource snapshot is its accepted baseline; another step's success cannot consume these local fields.
  const changed =
    (!space && (spaceTitle !== '' || spaceSummary !== '')) ||
    address !== (space?.address ?? '') ||
    realmTitle !== (realm?.title ?? '') ||
    realmSummary !== (realm?.summary ?? '') ||
    visibility !== (realm?.visibility ?? 'public') ||
    (contextState.selected !== null && contextState.selected.id !== (realm?.contextId ?? null)) ||
    (!contextState.selected && contextState.reference !== contextReferenceBaseline) ||
    (scheme !== null && scheme.id !== (realm?.schemeId ?? null)) ||
    (concept?.id ?? null) !== (acceptedBoard?.conceptId ?? null) ||
    boardTitle !== (acceptedBoard?.title ?? '') ||
    boardVisibility !== (acceptedBoard?.visibility ?? 'published') ||
    purpose !== (acceptedBoard?.purpose ?? 'discussion');
  const departure = useAuthoringDeparture(
    callerCurrent && loaded && (changed || pending !== null),
    pending !== null,
    JSON.stringify([
      spaceTitle,
      spaceSummary,
      address,
      realmTitle,
      realmSummary,
      visibility,
      contextState.reference,
      contextState.selected?.id,
      scheme?.id,
      concept?.id,
      boardTitle,
      boardVisibility,
      purpose,
      pending?.key,
      callerRevision,
    ]),
  );
  useCallerLayoutEffect(() => {
    const stop = caller.subscribe(() => {
      if (caller.isRetired()) departure.release();
    });
    return () => {
      stop();
    };
  }, [caller, departure.release]);
  useEffect(() => {
    if (conceptSelection?.source === boardChoices && !currentBoardConcept(conceptSelection, realm?.schemeId ?? null)) {
      setConceptSelection(null);
      setConceptCleared(true);
    }
  }, [conceptSelection, boardChoices, realm?.schemeId]);
  const previousBoardChoices = useRef(boardChoices);
  useEffect(() => {
    if (previousBoardChoices.current !== boardChoices) {
      previousBoardChoices.current = boardChoices;
      setSchemeSelection(null);
      setConceptSelection(null);
      setConceptCleared(false);
    }
  }, [boardChoices]);

  const observedTicket = useRef(caller.ticket());
  useEffect(() => {
    const ticket = caller.ticket();
    if (observedTicket.current === ticket) return;
    observedTicket.current = ticket;
    operation.current++;
    inFlight.current = false;
    setBusy(false);
  }, [caller, callerRevision]);

  async function refresh(spaceId = space?.id) {
    if (inFlight.current || !readReady || !caller.current()) return;
    const ticket = caller.ticket();
    const request = ++operation.current;
    inFlight.current = true;
    setBusy(true);
    try {
      const current = await transport.read(spaceId);
      if (!caller.owns(ticket) || operation.current !== request) return;
      if (current.kind === 'failure') setProblem(current);
      else {
        if (!loaded) {
          setSpaceTitle(current.space?.title ?? '');
          setSpaceSummary(current.space?.summary ?? '');
          setAddress(current.space?.address ?? '');
          setRealmTitle(current.realm?.title ?? '');
          setRealmSummary(current.realm?.summary ?? '');
          setVisibility(current.realm?.visibility ?? 'public');
          contextPicker.reference(current.realm?.contextId ?? '');
          setContextReferenceBaseline(current.realm?.contextId ?? '');
        }
        setSnapshot(current);
        setLoaded(true);
        setNeedsRefresh(false);
        setProblem(null);
      }
    } catch {
      if (caller.owns(ticket) && operation.current === request)
        setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      if (caller.owns(ticket) && operation.current === request) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function submit(draft: SetupDraftCommand) {
    if (inFlight.current || !loaded || (needsRefresh && !pending) || !commandReady || !caller.current()) return;
    const command = setupAttempt(pending, draft, crypto.randomUUID());
    // Pending retries replay their immutable command; new writes require the live picker choice.
    if (
      !pending &&
      (command.step === 'realm' || command.step === 'settings') &&
      !contextPicker.selection(command.contextId, contextSelectionVersion)
    )
      return;
    const activation = keyboardActivation.current;
    keyboardActivation.current = null;
    const ticket = caller.ticket();
    const request = ++operation.current;
    focusIntent.current =
      activation &&
      activation.generation === focusGeneration.current &&
      activation.pointer === pointerGeneration.current &&
      command.step !== 'space' &&
      command.step !== 'board'
        ? { ...activation, ticket, operation: request, step: null }
        : null;
    inFlight.current = true;
    setPending(command);
    setBusy(true);
    setProblem(null);
    try {
      const result = await transport.command(command);
      if (!caller.owns(ticket) || operation.current !== request) return;
      if (!retainSetupAttempt(result)) setPending(null);
      if (result.kind === 'failure') {
        focusGeneration.current++;
        focusIntent.current = null;
        setProblem(result);
        if (result.reason === 'conflict' || result.reason === 'denied') setNeedsRefresh(true);
        return;
      }
      let spaceId = space?.id;
      setSnapshot((current) => applySetupResult(current, result));
      if (result.kind === 'space') {
        spaceId = result.space.id;
        if (command.step === 'address') setAddress(result.space.address ?? address);
      }
      if (result.kind === 'realm' && (command.step === 'realm' || command.step === 'settings')) {
        setRealmTitle(result.realm.title);
        setRealmSummary(result.realm.summary);
        setVisibility(result.realm.visibility);
        setContextReferenceBaseline(contextPicker.getSnapshot().reference);
      }
      if (result.kind === 'board' && command.step === 'board') {
        setBoardId(result.id);
        setAcceptedBoard(command);
      }
      // A failed refresh must never discard the command's returned identity.
      setNeedsRefresh(true);
      const current = await transport.read(spaceId);
      if (!caller.owns(ticket) || operation.current !== request) return;
      if (current.kind === 'ready') {
        setSnapshot(current);
        setNeedsRefresh(false);
        const intent = focusIntent.current;
        const handoff = intent && intent.step === null && currentFocusIntent(intent) ? intent : undefined;
        if (command.step === 'address') advance(1, handoff?.source, handoff);
        if (command.step === 'realm' || command.step === 'settings') advance(2, handoff?.source, handoff);
        if (command.step === 'scheme') advance(3, handoff?.source, handoff);
      } else {
        focusGeneration.current++;
        focusIntent.current = null;
        setProblem(current);
        setNeedsRefresh(true);
      }
    } catch {
      if (caller.owns(ticket) && operation.current === request) {
        focusGeneration.current++;
        focusIntent.current = null;
        setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
      }
    } finally {
      if (caller.owns(ticket) && operation.current === request) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  const steps = [m.space_setup_identity(), m.space_setup_realm(), m.space_setup_scheme(), m.space_setup_board()];
  const icons = [MapPin, Users, LayoutList, MessageSquare];
  const completed = [Boolean(space?.address), Boolean(realm), Boolean(realm?.schemeId), Boolean(boardId)];
  const reachable = [true, Boolean(space?.address), Boolean(realm), Boolean(realm?.schemeId)];
  const canEdit =
    step === 0
      ? !space || permitted.address
      : step === 1
        ? realm
          ? permitted.settings
          : permitted.address
        : step === 2
          ? permitted.scheme
          : permitted.board;
  const titleId = useId();
  function advance(next: number, source?: HTMLElement, carried?: StepFocusIntent) {
    const generation = ++focusGeneration.current;
    const ticket = carried?.ticket ?? caller.ticket();
    const request = carried?.operation ?? operation.current;
    focusIntent.current =
      source && caller.current() && caller.owns(ticket) && operation.current === request
        ? { source, generation, pointer: pointerGeneration.current, ticket, operation: request, step: next }
        : null;
    keyboardActivation.current = null;
    setStep(next);
    setFocusCommit((commit) => commit + 1);
  }
  function nextButton(next: number) {
    return (
      <Button
        type="button"
        disabled={locked}
        onClick={(event) => advance(next, event.detail === 0 ? event.currentTarget : undefined)}
      >
        {m.space_setup_continue()}
        <ArrowRight className="shrink-0 rtl:rotate-180" aria-hidden="true" />
      </Button>
    );
  }
  const primaryLabel = busy
    ? m.space_setup_working()
    : step === 0
      ? space
        ? m.space_setup_save_address()
        : m.space_setup_create_space()
      : step === 1
        ? realm
          ? m.space_setup_save_settings()
          : m.space_setup_create_realm()
        : step === 2
          ? m.space_setup_save_scheme()
          : m.space_setup_create_board();
  function submitStep(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || locked || !commandReady) return;
    if (step === 0) {
      void submit(
        space
          ? { step: 'address', spaceId: space.id, head: space.head, address }
          : { step: 'space', title: spaceTitle, summary: spaceSummary },
      );
    } else if (step === 1 && space && context) {
      void submit(
        realm
          ? {
              step: 'settings',
              realmId: realm.id,
              head: realm.head,
              title: realmTitle,
              summary: realmSummary,
              visibility,
              contextId: context.id,
            }
          : {
              step: 'realm',
              spaceId: space.id,
              title: realmTitle,
              summary: realmSummary,
              visibility,
              contextId: context.id,
            },
      );
    } else if (step === 2 && realm && scheme) {
      void submit({ step: 'scheme', realmId: realm.id, head: realm.head, schemeId: scheme.id });
    } else if (step === 3 && realm?.schemeId && concept && !boardId) {
      void submit({
        step: 'board',
        realmId: realm.id,
        conceptId: concept.id,
        title: boardTitle,
        visibility: boardVisibility,
        purpose,
      });
    }
  }
  const choiceMissing = (step === 1 && !context) || (step === 2 && !scheme) || (step === 3 && !concept);
  if (callerRetired)
    return (
      <div role="status" className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
        {m.space_setup_unavailable()}
      </div>
    );
  return (
    <div
      className="min-w-0 space-y-6 [overflow-wrap:anywhere] [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:h-auto [&_button]:whitespace-normal [&_button]:text-start [&_input]:min-w-0 [&_select]:min-w-0 [&_p]:text-start [&_summary]:min-h-11 [&_summary]:content-center"
      aria-busy={busy}
      onKeyDownCapture={noteKeyboardActivation}
    >
      <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">{m.space_setup_journey_intro()}</p>
      <nav aria-label={m.space_setup_steps()}>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 [&>li]:min-w-0">
          {steps.map((label, index) => {
            const Icon = icons[index] ?? MapPin;
            return (
              <li key={label}>
                <button
                  type="button"
                  disabled={!reachable[index] || locked || paused || Boolean(boardId)}
                  aria-current={index === step ? 'step' : undefined}
                  onClick={(event) => advance(index, event.detail === 0 ? event.currentTarget : undefined)}
                  className="flex min-h-14 min-w-0 w-full items-center gap-2 rounded-xl border border-border px-3 py-3 text-start text-sm font-medium aria-[current=step]:border-primary aria-[current=step]:bg-primary/5 aria-[current=step]:text-primary disabled:opacity-50"
                >
                  {completed[index] ? (
                    <Check className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0">{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <section className="min-w-0" aria-labelledby={titleId}>
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium tracking-wide text-muted-foreground">
              {m.space_setup_step_number({ current: step + 1, total: steps.length })}
            </p>
            <h2 ref={heading} tabIndex={-1} id={titleId} className="text-2xl font-semibold tracking-tight outline-none">
              {boardId ? m.space_setup_complete() : paused ? m.space_setup_paused() : steps[step]}
            </h2>
            <div className="text-sm leading-relaxed text-muted-foreground">
              {boardId ? (
                <p>{m.space_setup_created_hint()}</p>
              ) : paused ? (
                <p>{m.space_setup_paused_hint()}</p>
              ) : step === 0 ? (
                <SetupDetails>{m.space_setup_identity_hint()}</SetupDetails>
              ) : step === 1 ? (
                <SetupDetails>{m.space_setup_realm_hint()}</SetupDetails>
              ) : step === 2 ? (
                <p>{m.space_setup_scheme_hint()}</p>
              ) : (
                <p>{m.space_setup_board_hint()}</p>
              )}
            </div>
          </div>
          {problem ? (
            <div className="mb-6 space-y-3 rounded-xl border border-border bg-muted p-4" role="alert">
              <p className="text-sm leading-relaxed">{problemText(problem)}</p>
              {pending ? (
                <Button disabled={busy || !callerCurrent || !commandReady} onClick={() => void submit(pending)}>
                  {m.space_setup_retry()}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy || !callerCurrent || !readReady}
                  onClick={() => void refresh()}
                >
                  {m.space_setup_refresh()}
                </Button>
              )}
            </div>
          ) : null}
          {boardId ? (
            <div role="status" className="space-y-4">
              <ContentItemFrame className="min-w-0 space-y-4 py-3 sm:py-4" aria-label={m.space_setup_complete()}>
                <ContentItemHeading level={3} className="text-xl font-semibold leading-snug">
                  {boardTitle}
                </ContentItemHeading>
                <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.space_setup_space()}</dt>
                    <dd className="mt-1 font-medium">{space?.title}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.space_setup_realm()}</dt>
                    <dd className="mt-1 font-medium">{realm?.title}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.space_setup_context_label()}</dt>
                    <dd className="mt-1 font-medium">
                      {contextState.current?.choice?.label ?? m.space_setup_details_name_unavailable()}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.space_setup_concept_label()}</dt>
                    <dd className="mt-1 font-medium">{concept?.label ?? m.space_setup_details_name_unavailable()}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.space_setup_visibility()}</dt>
                    <dd className="mt-1 font-medium">
                      {boardVisibility === 'published'
                        ? m.space_setup_public()
                        : boardVisibility === 'protected'
                          ? m.space_setup_protected()
                          : m.space_setup_draft()}
                    </dd>
                  </div>
                </dl>
                <ListRowControl className="flex min-w-0 flex-wrap gap-2" data-content-item-slot="actions">
                  <Link
                    to="/boards/$id"
                    params={{ id: boardId }}
                    className="inline-flex min-h-11 max-w-full items-center gap-2 font-medium text-primary underline underline-offset-4"
                  >
                    {m.space_setup_open_board()}
                    <ArrowRight className="size-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
                  </Link>
                </ListRowControl>
              </ContentItemFrame>
            </div>
          ) : paused ? (
            <Button onClick={() => setPaused(false)}>{m.space_setup_resume()}</Button>
          ) : (
            <form className="space-y-6" onSubmit={submitStep}>
              {conceptCleared && (step === 2 || step === 3) ? (
                <p role="status" className="text-sm leading-relaxed text-muted-foreground">
                  {m.space_setup_board_choice_scheme_changed()}
                </p>
              ) : null}
              <fieldset disabled={locked || !loaded || !canEdit} className="min-w-0 space-y-5">
                {step === 0 ? (
                  space ? (
                    <>
                      <ContentItemFrame className="min-w-0 space-y-2 py-3 sm:py-4">
                        <p className="text-sm text-muted-foreground">{m.space_setup_saved_space()}</p>
                        <ContentItemHeading level={3} className="text-lg font-semibold leading-snug">
                          {space.title}
                        </ContentItemHeading>
                        <p className="text-sm leading-relaxed text-muted-foreground">{space.summary}</p>
                      </ContentItemFrame>
                      {permitted.address ? (
                        <TextField
                          label={m.space_setup_address()}
                          value={address}
                          onChange={setAddress}
                          maxLength={64}
                          disabled={!commandReady}
                          description={m.space_setup_address_hint()}
                        />
                      ) : null}
                    </>
                  ) : (
                    <>
                      <TextField
                        label={m.space_setup_title()}
                        value={spaceTitle}
                        onChange={setSpaceTitle}
                        disabled={!commandReady}
                        description={m.space_setup_title_hint()}
                      />
                      <TextField
                        label={m.space_setup_summary()}
                        value={spaceSummary}
                        onChange={setSpaceSummary}
                        multiline
                        maxLength={4096}
                        disabled={!commandReady}
                        description={m.space_setup_summary_hint()}
                      />
                    </>
                  )
                ) : step === 1 ? (
                  <>
                    <TextField
                      label={m.space_setup_title()}
                      value={realmTitle}
                      onChange={setRealmTitle}
                      disabled={!commandReady}
                      description={m.space_setup_realm_title_hint()}
                    />
                    <TextField
                      label={m.space_setup_summary()}
                      value={realmSummary}
                      onChange={setRealmSummary}
                      multiline
                      maxLength={4096}
                      disabled={!commandReady}
                      description={m.space_setup_summary_hint()}
                    />
                    <SelectField
                      label={m.space_setup_visibility()}
                      value={visibility}
                      disabled={!commandReady}
                      onChange={(value) => {
                        if (value === 'public' || value === 'protected') setVisibility(value);
                      }}
                    >
                      <option value="public">{m.space_setup_public()}</option>
                      <option value="protected">{m.space_setup_protected()}</option>
                    </SelectField>
                    <p className="text-sm text-muted-foreground">
                      {visibility === 'public' ? m.space_setup_public_hint() : m.space_setup_protected_hint()}
                    </p>
                    <SetupContextPickerField picker={contextPicker} disabled={locked || !loaded || !canEdit} />
                    <p className="text-sm leading-relaxed text-muted-foreground">{m.space_setup_authority()}</p>
                  </>
                ) : step === 2 ? (
                  <SetupBoardPicker
                    kind="scheme"
                    source={boardChoices}
                    value={scheme}
                    onChange={(choice) => {
                      setSchemeSelection(choice ? { source: boardChoices, choice } : null);
                      if (currentConceptSelection && choice?.id !== currentConceptSelection.schemeId) {
                        setConceptSelection(null);
                        setConceptCleared(true);
                      }
                    }}
                    disabled={locked}
                  />
                ) : (
                  <>
                    <TextField
                      label={m.space_setup_title()}
                      value={boardTitle}
                      onChange={setBoardTitle}
                      disabled={!commandReady}
                      description={m.space_setup_board_title_hint()}
                    />
                    <SetupBoardPicker
                      kind="concept"
                      schemeId={realm?.schemeId ?? ''}
                      source={boardChoices}
                      value={concept}
                      onChange={(choice) => {
                        setConceptSelection(
                          choice && realm?.schemeId ? { source: boardChoices, schemeId: realm.schemeId, choice } : null,
                        );
                        setConceptCleared(false);
                      }}
                      disabled={locked}
                    />
                    <SelectField
                      label={m.space_setup_visibility()}
                      value={boardVisibility}
                      disabled={!commandReady}
                      onChange={(value) => {
                        if (value === 'published' || value === 'protected' || value === 'draft')
                          setBoardVisibility(value);
                      }}
                    >
                      <option value="published">{m.space_setup_public()}</option>
                      <option value="protected">{m.space_setup_protected()}</option>
                      <option value="draft">{m.space_setup_draft()}</option>
                    </SelectField>
                    <SelectField
                      label={m.space_setup_purpose()}
                      value={purpose}
                      disabled={!commandReady}
                      onChange={(value) => {
                        if (value === 'discussion' || value === 'reviews') setPurpose(value);
                      }}
                    >
                      <option value="discussion">{m.realm_board_purpose_discussion()}</option>
                      <option value="reviews">{m.realm_board_purpose_reviews()}</option>
                    </SelectField>
                  </>
                )}
              </fieldset>
              {!canEdit && loaded && !problem ? (
                <div className="space-y-3 rounded-xl bg-muted p-4 text-sm">
                  <p role="status">{m.space_setup_denied()}</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !callerCurrent || !readReady}
                    onClick={() => void refresh()}
                  >
                    {m.space_setup_refresh()}
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {step > 0 ? (
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={locked}
                      onClick={(event) => advance(step - 1, event.detail === 0 ? event.currentTarget : undefined)}
                    >
                      <ArrowLeft className="shrink-0 rtl:rotate-180" aria-hidden="true" />
                      {m.space_setup_back()}
                    </Button>
                  ) : null}
                  <Button variant="ghost" type="button" disabled={locked} onClick={() => setPaused(true)}>
                    {m.editor_cancel()}
                  </Button>
                </div>
                {step < 3 &&
                completed[step] &&
                (step === 0
                  ? address === space?.address
                  : step === 1
                    ? !context &&
                      realmTitle === realm?.title &&
                      realmSummary === realm?.summary &&
                      visibility === realm?.visibility
                    : !scheme) ? (
                  nextButton(step + 1)
                ) : (
                  <Button type="submit" disabled={locked || !loaded || !canEdit || !commandReady || choiceMissing}>
                    {primaryLabel}
                    <ArrowRight className="shrink-0 rtl:rotate-180" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </form>
          )}
          {busy ? (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {m.space_setup_working()}
            </p>
          ) : null}
        </section>
        <aside className="min-w-0" aria-label={m.space_setup_overview()}>
          <ContentItemFrame as="div" className="min-w-0 space-y-5 py-3 sm:py-4">
            <ContentItemHeading className="text-lg font-semibold">{m.space_setup_overview()}</ContentItemHeading>
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{m.space_setup_space()}</dt>
                <dd className="mt-1 break-words font-medium">
                  {space?.title || spaceTitle || m.space_setup_not_saved()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.space_setup_address()}</dt>
                <dd className="mt-1 break-all font-medium">
                  {space?.address ? `/spaces/${space.address}` : m.space_setup_not_saved()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.space_setup_realm()}</dt>
                <dd className="mt-1 break-words font-medium">{realm?.title || m.space_setup_not_saved()}</dd>
              </div>
              {realm ? (
                <div>
                  <dt className="text-muted-foreground">{m.space_setup_visibility()}</dt>
                  <dd className="mt-1 font-medium">
                    {realm.visibility === 'public' ? m.space_setup_public() : m.space_setup_protected()}
                  </dd>
                </div>
              ) : null}
              {context ? (
                <div>
                  <dt className="text-muted-foreground">{m.space_setup_context_label()}</dt>
                  <dd className="mt-1 break-words font-medium">{context.label}</dd>
                </div>
              ) : null}
              {scheme ? (
                <div>
                  <dt className="text-muted-foreground">{m.space_setup_scheme_label()}</dt>
                  <dd className="mt-1 break-words font-medium">{scheme.label}</dd>
                </div>
              ) : null}
            </dl>
            <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
              {m.space_setup_saved_hint()}
            </p>
            {space?.address ? (
              <Link
                to="/spaces/$address"
                params={{ address: space.address }}
                className="inline-flex min-h-11 max-w-full items-center gap-2 text-sm font-medium text-primary underline underline-offset-4"
              >
                {m.space_setup_home()}
                <ArrowRight className="size-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
              </Link>
            ) : null}
          </ContentItemFrame>
        </aside>
      </div>
    </div>
  );
}
