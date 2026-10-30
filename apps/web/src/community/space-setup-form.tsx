import { useId, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
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
} from './space-setup';

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
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength?: number;
  multiline?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    value,
    maxLength,
    required: !multiline,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? <Textarea {...props} /> : <Input {...props} />}
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
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-10 w-full rounded-xl border border-border bg-background px-3 text-foreground"
      >
        {children}
      </select>
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
  seed = '',
}: {
  kind: 'context' | 'scheme' | 'concept';
  label: string;
  value: SetupChoice | null;
  onChange(value: SetupChoice | null): void;
  transport: SetupTransport;
  disabled: boolean;
  seed?: string;
}) {
  const [text, setText] = useState(value?.id ?? seed);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SetupFailure | null>(null);
  const id = useId();
  async function resolve() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await transport.choice(kind, text.trim());
      if ('kind' in result) setProblem(result);
      else onChange(result);
    } catch {
      setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          value={text}
          maxLength={36}
          className="min-w-0 flex-1 basis-52"
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
          disabled={disabled || busy || !/^[0-9a-f-]{36}$/i.test(text.trim())}
          onClick={() => void resolve()}
        >
          {busy ? m.space_setup_working() : m.space_setup_resolve()}
        </Button>
      </div>
      {value ? <p className="text-sm font-medium">{value.label}</p> : null}
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
  const [boardId, setBoardId] = useState<string | null>(null);
  const [spaceTitle, setSpaceTitle] = useState(snapshot.space?.title ?? '');
  const [spaceSummary, setSpaceSummary] = useState(snapshot.space?.summary ?? '');
  const [address, setAddress] = useState(snapshot.space?.address ?? '');
  const [realmTitle, setRealmTitle] = useState(snapshot.realm?.title ?? '');
  const [realmSummary, setRealmSummary] = useState(snapshot.realm?.summary ?? '');
  const [visibility, setVisibility] = useState<'public' | 'protected'>(snapshot.realm?.visibility ?? 'public');
  const [context, setContext] = useState<SetupChoice | null>(null);
  const [scheme, setScheme] = useState<SetupChoice | null>(null);
  const [concept, setConcept] = useState<SetupChoice | null>(null);
  const [boardTitle, setBoardTitle] = useState('');
  const [boardVisibility, setBoardVisibility] = useState<'published' | 'protected' | 'draft'>('published');
  const [purpose, setPurpose] = useState<'discussion' | 'reviews'>('discussion');
  const locked = busy || pending !== null || needsRefresh;
  const { space, realm, permitted } = snapshot;

  async function refresh(spaceId = space?.id) {
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
        }
        setSnapshot(current);
        setLoaded(true);
        setNeedsRefresh(false);
        setProblem(null);
      }
    } catch {
      setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      setBusy(false);
    }
  }
  async function submit(draft: SetupDraftCommand) {
    if (busy) return;
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
      if (result.kind === 'space') spaceId = result.space.id;
      if (result.kind === 'board') setBoardId(result.id);
      // A failed refresh must never discard the command's returned identity.
      setNeedsRefresh(true);
      const current = await transport.read(spaceId);
      if (current.kind === 'ready') {
        setSnapshot(current);
        setNeedsRefresh(false);
      } else {
        setProblem(current);
        setNeedsRefresh(true);
      }
    } catch {
      setProblem({ kind: 'failure', reason: 'unavailable', status: 503 });
    } finally {
      setBusy(false);
    }
  }
  function form(event: React.FormEvent, draft: SetupDraftCommand) {
    event.preventDefault();
    void submit(draft);
  }
  const card = 'space-y-5 rounded-2xl border border-border p-5 sm:p-6';
  return (
    <div className="max-w-3xl space-y-6" aria-busy={busy}>
      <p className="text-muted-foreground">{m.space_setup_intro()}</p>
      {problem ? (
        <div className="space-y-3 rounded-xl bg-muted p-4" role="alert">
          <p>{problemText(problem)}</p>
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
      {space?.address ? (
        <Link
          to="/spaces/$address"
          params={{ address: space.address }}
          className="inline-flex min-h-10 items-center text-primary underline"
        >
          {m.space_setup_home()}
        </Link>
      ) : null}
      {boardId ? (
        <div role="status" className={card}>
          <p>{m.space_setup_complete()}</p>
          <Link
            to="/boards/$id"
            params={{ id: boardId }}
            className="inline-flex min-h-10 items-center text-primary underline"
          >
            {m.space_setup_open_board()}
          </Link>
        </div>
      ) : null}
      <section className={card} aria-labelledby="setup-space">
        <h2 id="setup-space" className="text-xl font-semibold">
          {m.space_setup_space()}
        </h2>
        {space ? (
          <p>{space.title}</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => form(event, { step: 'space', title: spaceTitle, summary: spaceSummary })}
          >
            <fieldset disabled={locked || !loaded} className="space-y-4">
              <TextField label={m.space_setup_title()} value={spaceTitle} onChange={setSpaceTitle} />
              <TextField
                label={m.space_setup_summary()}
                value={spaceSummary}
                onChange={setSpaceSummary}
                multiline
                maxLength={4096}
              />
              <Button type="submit">{m.space_setup_create_space()}</Button>
            </fieldset>
          </form>
        )}
      </section>
      {space && permitted.address ? (
        <section className={card} aria-labelledby="setup-address">
          <h2 id="setup-address" className="text-xl font-semibold">
            {m.space_setup_address()}
          </h2>
          <form onSubmit={(event) => form(event, { step: 'address', spaceId: space.id, head: space.head, address })}>
            <fieldset disabled={locked} className="space-y-4">
              <TextField label={m.space_setup_address()} value={address} onChange={setAddress} maxLength={64} />
              <Button type="submit">{m.space_setup_save_address()}</Button>
            </fieldset>
          </form>
        </section>
      ) : null}
      {space && (!realm ? permitted.address : permitted.settings) ? (
        <section className={card} aria-labelledby="setup-realm">
          <h2 id="setup-realm" className="text-xl font-semibold">
            {m.space_setup_realm()}
          </h2>
          <form
            onSubmit={(event) => {
              if (context)
                form(
                  event,
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
              else event.preventDefault();
            }}
          >
            <fieldset disabled={locked} className="space-y-4">
              <TextField label={m.space_setup_title()} value={realmTitle} onChange={setRealmTitle} />
              <TextField
                label={m.space_setup_summary()}
                value={realmSummary}
                onChange={setRealmSummary}
                multiline
                maxLength={4096}
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
              <Choice
                kind="context"
                seed={realm?.contextId ?? ''}
                label={m.space_setup_context()}
                value={context}
                onChange={setContext}
                transport={transport}
                disabled={locked}
              />
              <p className="text-sm text-muted-foreground">{m.space_setup_authority()}</p>
              <Button type="submit" disabled={!context}>
                {realm ? m.space_setup_save_settings() : m.space_setup_create_realm()}
              </Button>
            </fieldset>
          </form>
        </section>
      ) : null}
      {realm && permitted.scheme ? (
        <section className={card} aria-labelledby="setup-scheme">
          <h2 id="setup-scheme" className="text-xl font-semibold">
            {m.space_setup_scheme()}
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (scheme) void submit({ step: 'scheme', realmId: realm.id, head: realm.head, schemeId: scheme.id });
            }}
          >
            <fieldset disabled={locked} className="space-y-4">
              <Choice
                kind="scheme"
                seed={realm.schemeId ?? ''}
                label={m.space_setup_scheme_id()}
                value={scheme}
                onChange={setScheme}
                transport={transport}
                disabled={locked}
              />
              <Button type="submit" disabled={!scheme}>
                {m.space_setup_save_scheme()}
              </Button>
            </fieldset>
          </form>
        </section>
      ) : null}
      {realm && permitted.board ? (
        <section className={card} aria-labelledby="setup-board">
          <h2 id="setup-board" className="text-xl font-semibold">
            {m.space_setup_board()}
          </h2>
          {!realm.schemeId ? (
            <p>{m.space_setup_scheme_required()}</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (concept)
                  void submit({
                    step: 'board',
                    realmId: realm.id,
                    conceptId: concept.id,
                    title: boardTitle,
                    visibility: boardVisibility,
                    purpose,
                  });
              }}
            >
              <fieldset disabled={locked || boardId !== null} className="space-y-4">
                <TextField label={m.space_setup_title()} value={boardTitle} onChange={setBoardTitle} />
                <Choice
                  kind="concept"
                  label={m.space_setup_concept()}
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
                    if (value === 'published' || value === 'protected' || value === 'draft') setBoardVisibility(value);
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
                <Button type="submit" disabled={!concept}>
                  {m.space_setup_create_board()}
                </Button>
              </fieldset>
            </form>
          )}
        </section>
      ) : null}
      {space && !permitted.address && !permitted.settings && !permitted.board ? (
        <p role="status">{m.space_setup_denied()}</p>
      ) : null}
      {busy ? <p role="status">{m.space_setup_working()}</p> : null}
    </div>
  );
}
