import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ArrowRight, ArrowLeft, MapPin, Users, LayoutList, MessageSquare } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { m } from '../../../paraglide/messages.js';
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

export type SetupTransport = {
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
function TextField({
  label,
  value,
  onChange,
  maxLength = 1024,
  multiline = false,
  description,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength?: number;
  multiline?: boolean;
  description?: string;
}) {
  const id = useId();
  const props = {
    id,
    value,
    maxLength,
    required: !multiline,
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
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
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
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SetupFailure | null>(null);
  const id = useId();
  async function resolve() {
    const request = ++generation.current;
    setBusy(true);
    setProblem(null);
    try {
      const result = await transport.choice(kind, text.trim());
      if (request !== generation.current) return;
      if ('kind' in result) setProblem(result);
      else onChange(result);
    } catch {
      if (request === generation.current) setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      if (request === generation.current) setBusy(false);
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

/** One command at a time; draft values live independently of refreshed authoritative heads. */
export function SpaceSetupForm({
  initial,
  transport,
}: {
  initial: SetupSnapshot | SetupFailure;
  transport: SetupTransport;
}) {
  const [snapshot, setSnapshot] = useState(initial.kind === 'ready' ? initial : emptySetup);
  const [problem, setProblem] = useState<SetupFailure | null>(initial.kind === 'failure' ? initial : null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(initial.kind === 'ready');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [pending, setPending] = useState<SetupCommand | null>(null);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [spaceTitle, setSpaceTitle] = useState(snapshot.space?.title ?? '');
  const [spaceSummary, setSpaceSummary] = useState(snapshot.space?.summary ?? '');
  const [address, setAddress] = useState(snapshot.space?.address ?? '');
  const [realmTitle, setRealmTitle] = useState(snapshot.realm?.title ?? '');
  const [realmSummary, setRealmSummary] = useState(snapshot.realm?.summary ?? '');
  const [visibility, setVisibility] = useState<'public' | 'protected'>(snapshot.realm?.visibility ?? 'public');
  const [contextReference, setContextReference] = useState(snapshot.realm?.contextId ?? '');
  const [schemeReference, setSchemeReference] = useState(snapshot.realm?.schemeId ?? '');
  const [conceptReference, setConceptReference] = useState('');
  const [context, setContext] = useState<SetupChoice | null>(null);
  const [scheme, setScheme] = useState<SetupChoice | null>(null);
  const [concept, setConcept] = useState<SetupChoice | null>(null);
  const [boardTitle, setBoardTitle] = useState('');
  const [boardVisibility, setBoardVisibility] = useState<'published' | 'protected' | 'draft'>('published');
  const [purpose, setPurpose] = useState<'discussion' | 'reviews'>('discussion');
  const locked = busy || pending !== null || needsRefresh;
  const { space, realm, permitted } = snapshot;

  async function refresh(spaceId = space?.id) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const current = await transport.read(spaceId);
      if (current.kind === 'failure') setProblem(current);
      else {
        if (!loaded) {
          setSpaceTitle(current.space?.title ?? '');
          setSpaceSummary(current.space?.summary ?? '');
          setAddress(current.space?.address ?? '');
          setRealmTitle(current.realm?.title ?? '');
          setRealmSummary(current.realm?.summary ?? '');
          setVisibility(current.realm?.visibility ?? 'public');
          setContextReference(current.realm?.contextId ?? '');
          setSchemeReference(current.realm?.schemeId ?? '');
        }
        setSnapshot(current);
        setLoaded(true);
        setNeedsRefresh(false);
        setProblem(null);
      }
    } catch {
      setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function submit(draft: SetupDraftCommand) {
    if (inFlight.current || !loaded || (needsRefresh && !pending)) return;
    inFlight.current = true;
    const command = setupAttempt(pending, draft, crypto.randomUUID());
    setPending(command);
    setBusy(true);
    setProblem(null);
    try {
      const result = await transport.command(command);
      if (!retainSetupAttempt(result)) setPending(null);
      if (result.kind === 'failure') {
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
      if (result.kind === 'board') setBoardId(result.id);
      // A failed refresh must never discard the command's returned identity.
      setNeedsRefresh(true);
      const current = await transport.read(spaceId);
      if (current.kind === 'ready') {
        setSnapshot(current);
        setNeedsRefresh(false);
        if (command.step === 'address') advance(1);
        if (command.step === 'realm' || command.step === 'settings') advance(2);
        if (command.step === 'scheme') advance(3);
      } else {
        setProblem(current);
        setNeedsRefresh(true);
      }
    } catch {
      setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      inFlight.current = false;
      setBusy(false);
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
  function advance(next: number) {
    setStep(next);
    // The heading persists across steps, so keyboard navigation keeps a stable focus target.
    heading.current?.focus();
  }
  function nextButton(next: number) {
    return (
      <Button type="button" disabled={locked} onClick={() => advance(next)}>
        {m.space_setup_continue()}
        <ArrowRight aria-hidden="true" />
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
    if (!canEdit || locked) return;
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
  return (
    <div className="space-y-6" aria-busy={busy}>
      <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">{m.space_setup_journey_intro()}</p>
      <nav aria-label={m.space_setup_steps()}>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {steps.map((label, index) => {
            const Icon = icons[index] ?? MapPin;
            return (
              <li key={label}>
                <button
                  type="button"
                  disabled={!reachable[index] || locked || paused || Boolean(boardId)}
                  aria-current={index === step ? 'step' : undefined}
                  onClick={() => advance(index)}
                  className="flex min-h-14 w-full items-center gap-2 rounded-xl border border-border px-3 py-3 text-start text-sm font-medium aria-[current=step]:border-primary aria-[current=step]:bg-primary/5 aria-[current=step]:text-primary disabled:opacity-50"
                >
                  {completed[index] ? (
                    <Check className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <section className="min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-7" aria-labelledby={titleId}>
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium tracking-wide text-muted-foreground">
              {m.space_setup_step_number({ current: step + 1, total: steps.length })}
            </p>
            <h2 ref={heading} tabIndex={-1} id={titleId} className="text-2xl font-semibold tracking-tight outline-none">
              {boardId ? m.space_setup_complete() : paused ? m.space_setup_paused() : steps[step]}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {boardId
                ? m.space_setup_created_hint()
                : paused
                  ? m.space_setup_paused_hint()
                  : step === 0
                    ? m.space_setup_identity_hint()
                    : step === 1
                      ? m.space_setup_realm_hint()
                      : step === 2
                        ? m.space_setup_scheme_hint()
                        : m.space_setup_board_hint()}
            </p>
          </div>
          {problem ? (
            <div className="mb-6 space-y-3 rounded-xl border border-border bg-muted p-4" role="alert">
              <p className="text-sm leading-relaxed">{problemText(problem)}</p>
              {pending ? (
                <Button disabled={busy} onClick={() => void submit(pending)}>
                  {m.space_setup_retry()}
                </Button>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
                  {m.space_setup_refresh()}
                </Button>
              )}
            </div>
          ) : null}
          {boardId ? (
            <div role="status" className="space-y-4">
              <p className="font-medium">{boardTitle}</p>
              <Link
                to="/boards/$id"
                params={{ id: boardId }}
                className="inline-flex min-h-11 items-center gap-2 font-medium text-primary underline underline-offset-4"
              >
                {m.space_setup_open_board()}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          ) : paused ? (
            <Button onClick={() => setPaused(false)}>{m.space_setup_resume()}</Button>
          ) : (
            <form className="space-y-6" onSubmit={submitStep}>
              <fieldset disabled={locked || !loaded || !canEdit} className="space-y-5">
                {step === 0 ? (
                  space ? (
                    <>
                      <div className="rounded-xl bg-muted p-4">
                        <p className="text-xs text-muted-foreground">{m.space_setup_saved_space()}</p>
                        <p className="mt-1 break-words font-medium">{space.title}</p>
                      </div>
                      {permitted.address ? (
                        <TextField
                          label={m.space_setup_address()}
                          value={address}
                          onChange={setAddress}
                          maxLength={64}
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
                        description={m.space_setup_title_hint()}
                      />
                      <TextField
                        label={m.space_setup_summary()}
                        value={spaceSummary}
                        onChange={setSpaceSummary}
                        multiline
                        maxLength={4096}
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
                      description={m.space_setup_realm_title_hint()}
                    />
                    <TextField
                      label={m.space_setup_summary()}
                      value={realmSummary}
                      onChange={setRealmSummary}
                      multiline
                      maxLength={4096}
                      description={m.space_setup_summary_hint()}
                    />
                    <SelectField
                      label={m.space_setup_visibility()}
                      value={visibility}
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
                    <Choice
                      kind="context"
                      reference={contextReference}
                      onReferenceChange={setContextReference}
                      label={m.space_setup_context_label()}
                      value={context}
                      onChange={setContext}
                      transport={transport}
                      disabled={locked}
                    />
                    <p className="text-sm leading-relaxed text-muted-foreground">{m.space_setup_authority()}</p>
                  </>
                ) : step === 2 ? (
                  <Choice
                    kind="scheme"
                    reference={schemeReference}
                    onReferenceChange={setSchemeReference}
                    label={m.space_setup_scheme_label()}
                    value={scheme}
                    onChange={setScheme}
                    transport={transport}
                    disabled={locked}
                  />
                ) : (
                  <>
                    <TextField
                      label={m.space_setup_title()}
                      value={boardTitle}
                      onChange={setBoardTitle}
                      description={m.space_setup_board_title_hint()}
                    />
                    <Choice
                      kind="concept"
                      reference={conceptReference}
                      onReferenceChange={setConceptReference}
                      label={m.space_setup_concept_label()}
                      value={concept}
                      onChange={setConcept}
                      transport={transport}
                      disabled={locked}
                    />
                    <p className="text-sm text-muted-foreground">{m.space_setup_concept_hint()}</p>
                    <SelectField
                      label={m.space_setup_visibility()}
                      value={boardVisibility}
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
              {!canEdit && loaded ? (
                <p role="status" className="rounded-xl bg-muted p-4 text-sm">
                  {m.space_setup_denied()}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <div className="flex items-center gap-2">
                  {step > 0 ? (
                    <Button variant="ghost" type="button" disabled={locked} onClick={() => advance(step - 1)}>
                      <ArrowLeft aria-hidden="true" />
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
                  <Button type="submit" disabled={locked || !loaded || !canEdit || choiceMissing}>
                    {primaryLabel}
                    <ArrowRight aria-hidden="true" />
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
        <aside className="space-y-5 rounded-2xl bg-muted/50 p-5" aria-label={m.space_setup_overview()}>
          <h2 className="text-sm font-semibold">{m.space_setup_overview()}</h2>
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
              className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              {m.space_setup_home()}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
