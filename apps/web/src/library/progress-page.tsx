import { progressAddressIssue } from './progress-address';
import { ProgressAddressCorrection } from './progress-address-correction';
import { Exposure, useOperation } from '../kernel/exposure';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel, FieldLegend } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import type { CoverRatio } from '@rezics/ui/cover';
import { EllipsisIcon } from 'lucide-react';
import { progressIndexSubjects } from './progress-subjects';
import { ProgressPicker, pickerSubject, type ProgressPickerSubject } from './progress-picker';
import { ProgressRow } from '@rezics/ui/progress-row';
import { ContentItem } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Link, useRouter } from '@tanstack/react-router';
import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import {
  progressIndexAdmission,
  progressIndexSession,
  progressRowContext,
  useProgressAction,
  useProgressEpisode,
  type ProgressAuthority,
} from './progress-index-origin';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { useHistoryAddress } from './history-current-origin';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import type { ProgressFinishInput, ProgressIndex, ProgressMode, ProgressStartInput } from './progress-reads';
import { progressFailureMessage, progressView } from './progress-label';
import type { ProgressChoices } from './progress-profile';
import {
  finishProgressSession,
  startProgressSession,
  readProgressChoices,
  readCurrentViewerProgressIndex,
  type CurrentViewerProgressIndex,
} from './progress-server';
import { rowRatio, SubjectCover } from './subject-row';
import { displayLibraryTitle } from './title';

const modeChoices: { value: ProgressMode; label: () => string }[] = [
  { value: 'scalar_amount', label: () => m.library_progress_mode_amount() },
  { value: 'cursor_position', label: () => m.library_progress_mode_cursor() },
  { value: 'completed_units', label: () => m.library_progress_mode_units() },
];

function stateLabel(state: ProgressIndex['sessions'][number]['state']): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

const buttonClass =
  'inline-flex min-h-[44px] min-w-0 max-w-full items-center justify-center rounded-lg border border-border px-4 py-2 text-center whitespace-normal wrap-anywhere text-primary underline-offset-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const subscribe = () => () => {};
type ProgressCommand<Input, Sender> = {
  data: Input;
  headers: NonNullable<ReturnType<typeof csrfHeaders>>;
  send: Sender;
};
const progressOperations = [
  'progress_session.list',
  'progress_session.create',
  'progress_session.read',
  'progress_session.complete',
  'progress_session.abandon',
] as const;

/** Mounted by the real route: loader provenance is authority only for SSR/initial hydration. */
export function CurrentViewerProgressIndexPage({
  loader,
  requested,
}: {
  loader: CurrentViewerProgressIndex;
  requested: { subjectId?: string; cursor?: string };
}) {
  const renderedSession = useSession();
  const client = useQueryClient();
  const instance = useId();
  const { store, value: scoped } = useLibraryWorkspaceAdmission(progressOperations);
  const admitted = useOperation('progress_session.list');
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = getLocale();
  const subjectId = requested.subjectId ?? '';
  const cursor = requested.cursor ?? null;
  const addressIssue = progressAddressIssue(requested);
  const viewer = hydrated ? scoped.subject : loader.viewer;
  const allowed = hydrated ? progressIndexAdmission(client, 'progress_session.list', admitted) : loader.page.signedIn;
  const address = useHistoryAddress('/library/progress', requested.cursor, locale);
  const scope = JSON.stringify([viewer, scoped.viewer, subjectId, cursor, locale, address.key]);
  const origin = useProgressEpisode(
    scope,
    () => {
      if (getLocale() !== locale || !address.isCurrent()) return false;
      if (!hydrated) return !!viewer && allowed;
      const now = progressIndexSession(client, renderedSession);
      return !!viewer && store.read().viewer === scoped.viewer && now.state === 'signed-in' && now.subject === viewer;
    },
    () => store.read().subject !== viewer,
    () => !hydrated || progressIndexAdmission(client, 'progress_session.list', admitted),
  );
  const matches = (result: CurrentViewerProgressIndex | undefined) =>
    !!viewer &&
    result?.viewer === viewer &&
    result.locale === locale &&
    result.requested.subjectId === subjectId &&
    result.requested.cursor === cursor &&
    result.page.signedIn &&
    result.page.subjectId === subjectId;
  // Each newly delivered loader may seed its matching scope once. A retained
  // loader cannot seed another lifetime after identity/admission retirement.
  const loaderSource = useRef({ loader, origin });
  if (loaderSource.current.loader !== loader) loaderSource.current = { loader, origin };
  const queryKey = [
    'library',
    'progress',
    'current-viewer',
    viewer,
    subjectId,
    cursor,
    locale,
    origin.generation,
    instance,
  ] as const;
  const listVersion = store.dispatchVersion('progress_session.list');
  const query = useQuery({
    ...personalRead,
    queryKey,
    queryFn: async () => {
      const currentRead = () => origin.isCurrent() && store.dispatchVersion('progress_session.list') === listVersion;
      if (!currentRead()) throw new CancelledError({ silent: true, revert: true });
      try {
        const result = await readCurrentViewerProgressIndex({
          data: {
            ...requested,
          },
        });
        if (!currentRead()) throw new CancelledError({ silent: true, revert: true });
        return result;
      } catch (error) {
        if (!currentRead()) throw new CancelledError({ silent: true, revert: true });
        throw error;
      }
    },
    enabled: personalRead.enabled && hydrated && !!viewer && allowed && !addressIssue,
    // Do not duplicate the bounded loader read on hydration. Invalidations still refetch.
    initialData: loaderSource.current.origin === origin && matches(loader) ? loader : undefined,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  // A loader refresh and a query refresh are both fresh sources, without becoming
  // draft/reset identities. A rejected envelope also retires the previous query page.
  const latest = useRef({ origin, loader, query: query.data, result: query.data });
  if (latest.current.origin !== origin) {
    latest.current = { origin, loader, query: query.data, result: query.data };
  } else {
    if (latest.current.loader !== loader) {
      latest.current.loader = loader;
      latest.current.result = loader;
    }
    if (latest.current.query !== query.data) {
      latest.current.query = query.data;
      latest.current.result = query.data;
    }
  }
  const result = hydrated ? latest.current.result : loader;
  // A cache delivery can replace provenance before React commits its notification.
  // Retire the page operand without automatically replaying the bounded list read.
  const currentResult = () => {
    const state = client.getQueryState<CurrentViewerProgressIndex>(queryKey);
    return state?.data !== query.data ? state?.data : result;
  };
  const source = useProgressEpisode(origin, () => {
    const state = client.getQueryState<CurrentViewerProgressIndex>(queryKey);
    return !origin.retired && origin.validate() && state?.status !== 'error' && matches(currentResult());
  });
  const rowSource = useRef<{ page?: ProgressIndex; contexts: Set<string> }>({ contexts: new Set() });
  const authority: ProgressAuthority = {
    key: source,
    isCurrent: () =>
      origin.isCurrent() && source.isCurrent() && store.dispatchVersion('progress_session.list') === listVersion,
    permits: (operation, rendered) =>
      !source.retired && source.validate() && hydrated && progressIndexAdmission(client, operation, rendered),
    episode: (operation) => store.dispatchVersion(operation),
    retained: (operation) =>
      scoped.granted[progressOperations.indexOf(operation as (typeof progressOperations)[number])] === true,
    rowCurrent: (context) => {
      const page = currentResult()?.page;
      if (rowSource.current.page !== page) {
        rowSource.current = { ...(page ? { page } : {}), contexts: new Set(page?.sessions.map(progressRowContext)) };
      }
      return rowSource.current.contexts.has(context);
    },
    headers: () => {
      if (!origin.isCurrent() || !source.isCurrent() || !hydrated) return null;
      const now = progressIndexSession(client, renderedSession);
      return now.csrfToken ? { 'x-csrf-token': now.csrfToken } : null;
    },
  };
  if (addressIssue || (matches(result) && result?.page.addressIssue))
    return <ProgressAddressCorrection address={requested} issue={addressIssue ?? result?.page.addressIssue} />;
  if (origin.retired || source.retired || query.isError || !matches(result))
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        {viewer && allowed ? (
          <>
            <p role="status">{m.library_progress_unavailable()}</p>
            <ProgressAddressCorrection address={requested} pending={query.isFetching} />
            <Button
              variant="outline"
              disabled={query.isFetching}
              onClick={() => {
                if (origin.isCurrent()) void query.refetch();
              }}
            >
              {m.library_progress_retry()}
            </Button>
          </>
        ) : null}
      </article>
    );
  return (
    <div hidden={hydrated && !allowed}>
      <ProgressIndexPage
        key={`${scope}:${source.generation}`}
        page={result!.page}
        cursor={cursor}
        authority={authority}
      />
    </div>
  );
}

export function ProgressIndexPage({
  page,
  cursor,
  authority,
}: {
  page: ProgressIndex;
  cursor?: string | null;
  authority?: ProgressAuthority;
}) {
  const router = useRouter();
  const identity = authority?.key ?? page;
  const creatable = useOperation('progress_session.create');
  const admission = useRef(creatable);
  admission.current = creatable;
  const episode = useProgressAction(authority, 'progress_session.create', creatable, identity);
  const current = () => episode.isCurrent() && admission.current;
  const intent = useRef<ProgressCommand<ProgressStartInput, typeof startProgressSession> | null>(null);
  const sessions = progressIndexSubjects(page.sessions);
  const [chosen, setChosen] = useState(() => {
    const subject = page.selectedSubject;
    return subject ? [pickerSubject(subject)] : [];
  });
  const [seenIdentity, setSeenIdentity] = useState(episode);
  const [version, setVersion] = useState<ProgressPickerSubject[]>([]);
  const subject = chosen[0]?.id ?? '';
  const [choices, setChoices] = useState<ProgressChoices>(page.progressChoices);
  const [choicesUnavailable, setChoicesUnavailable] = useState(page.choicesUnavailable ?? false);
  const [selectedMode, setMode] = useState<ProgressMode | undefined>(page.progressChoices?.[0]?.mode);
  const [selectedUnit, setUnit] = useState('');
  const mode = choices?.find((choice) => choice.mode === selectedMode)?.mode ?? choices?.[0]?.mode;
  const units = choices?.find((choice) => choice.mode === mode)?.units ?? [];
  const pair = units.find((unit) => unit.id === selectedUnit) ?? units[0];
  const progressDefaultUnit = units[0]?.id ?? '';
  const unit = pair?.id ?? progressDefaultUnit;
  const choiceRequest = useRef(0);
  const [choosing, setChoosing] = useState(false);
  const [total, setTotal] = useState('');
  const [key, setKey] = useState(page.idempotencyKey);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (seenIdentity !== episode) {
    setSeenIdentity(episode);
    if (!authority || (seenIdentity.identity !== episode.identity && seenIdentity.revoked)) intent.current = null;
    if (intent.current) {
      setAlert(m.library_progress_unavailable());
      setPending(false);
    } else {
      setChoices(page.progressChoices);
      setChoicesUnavailable(page.choicesUnavailable ?? false);
      choiceRequest.current++;
      setChoosing(false);
      setVersion([]);
      setTotal('');
      setUnit('');
      setMode(page.progressChoices?.[0]?.mode);
      setKey(authority ? crypto.randomUUID() : page.idempotencyKey);
      setAlert(null);
      setPending(false);
      const next = page.selectedSubject;
      setChosen(next ? [pickerSubject(next)] : []);
    }
  }

  const draftLocked = pending || (!!authority && intent.current !== null);
  const [, renderDraft] = useState(0);
  const draftScope = JSON.stringify([subject, chosen[0]?.type, version[0]?.id, mode, unit, total, key]);
  const draftRef = useRef<{ scope: string; token: object }>({ scope: draftScope, token: {} });
  if (draftRef.current.scope !== draftScope) draftRef.current = { scope: draftScope, token: {} };
  const draft = draftRef.current;
  const draftCurrent = () => current() && draftRef.current === draft;
  const changeDraft = (change: () => void) => {
    if (!draftCurrent() || episode.pending || (!!authority && intent.current !== null)) return;
    draftRef.current = { scope: draftScope, token: {} };
    renderDraft((value) => value + 1);
    change();
  };

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const origin = episode;
    if (!current() || !draftCurrent() || origin.pending || (!intent.current && (!mode || !pair))) return;
    origin.pending = true;
    setAlert(null);
    setPending(true);
    const totalValue = pair?.total !== 'forbidden' ? total.trim() : '';
    try {
      const headers = authority ? authority.headers() : csrfHeaders();
      if (!headers || !current()) return;
      const command = (intent.current ??= {
        data: {
          subjectId: subject.trim(),
          ...(version[0] ? { versionSubjectId: version[0].id } : {}),
          mode: mode!,
          unit,
          idempotencyKey: key,
          ...(totalValue ? { total: totalValue } : {}),
        },
        headers,
        send: startProgressSession,
      });
      const result = await command.send({ data: command.data, headers: command.headers });
      if (!draftCurrent()) return;
      if (!result.ok) {
        setAlert(progressFailureMessage(result.reason));
        if (authority && result.reason !== 'unavailable') {
          intent.current = null;
          draftRef.current = { scope: draftScope, token: {} };
          setKey(crypto.randomUUID());
        }
        return;
      }
      intent.current = null;
      draftRef.current = { scope: draftScope, token: {} };
      setKey(crypto.randomUUID());
      if (!current()) return;
      window.location.assign(router.buildLocation({ to: '/library/progress/$id', params: { id: result.id } }).href);
    } catch {
      if (draftCurrent()) setAlert(m.library_progress_unavailable());
    } finally {
      if (current()) {
        origin.pending = false;
        setPending(false);
      }
    }
  }

  if (page.addressIssue)
    return (
      <ProgressAddressCorrection
        address={{ subjectId: page.subjectId, ...(cursor === undefined || cursor === null ? {} : { cursor }) }}
        issue={page.addressIssue}
      />
    );
  const ratio = rowRatio(sessions.map((session) => session.subject));
  return (
    <article className="max-w-4xl space-y-10 text-foreground">
      <PageHeading>{m.library_progress_heading()}</PageHeading>

      <>
        {sessions.length ? (
          <ol className="space-y-3">
            {sessions.map((session) => (
              <SessionRow
                key={authority ? session.id : `${session.id}:${session.revision}`}
                session={session}
                ratio={ratio}
                sourcePage={page}
                authority={authority}
              />
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">
            {cursor || page.next
              ? m.library_progress_page_empty()
              : page.subjectId
                ? m.library_progress_empty()
                : m.library_progress_address_choose()}
          </p>
        )}
        {cursor || page.next ? (
          <Exposure operation="progress_session.list">
            <nav aria-label={m.library_progress_index_reader_pagination()} className="flex flex-wrap gap-2">
              {cursor ? (
                <Link
                  to="/library/progress"
                  search={{ subjectId: page.subjectId }}
                  onClick={(event) => {
                    if (authority && !authority.isCurrent()) event.preventDefault();
                  }}
                  className={buttonClass}
                >
                  {m.library_collections_first_page()}
                </Link>
              ) : null}
              {page.next ? (
                <Link
                  to="/library/progress"
                  search={{ subjectId: page.subjectId, cursor: page.next }}
                  onClick={(event) => {
                    if (authority && !authority.isCurrent()) event.preventDefault();
                  }}
                  className={buttonClass}
                >
                  {m.library_progress_more()}
                </Link>
              ) : null}
            </nav>
          </Exposure>
        ) : null}
        <Exposure operation="progress_session.create">
          <section aria-labelledby="start-progress-heading" className="space-y-5">
            <h2 id="start-progress-heading" className="text-xl font-semibold">
              {m.library_progress_start_heading()}
            </h2>
            <Field>
              <FieldLabel>{m.library_progress_subject()}</FieldLabel>
              <ProgressPicker
                key={episode.generation}
                isCurrent={draftCurrent}
                disabled={draftLocked}
                value={chosen}
                onValueChange={async (value) => {
                  if (!draftCurrent() || episode.pending || (!!authority && intent.current !== null)) return;
                  draftRef.current = { scope: draftScope, token: {} };
                  renderDraft((value) => value + 1);
                  const request = ++choiceRequest.current;
                  const latest = () => current() && request === choiceRequest.current;
                  setChosen(value);
                  setVersion([]);
                  setTotal('');
                  setChoices(undefined);
                  setChoicesUnavailable(false);
                  setChoosing(true);
                  setAlert(null);
                  try {
                    if (!latest()) return;
                    const next = value[0]
                      ? await readProgressChoices({ data: value[0].type ?? value[0].types[0] ?? '' })
                      : undefined;
                    if (!latest()) return;
                    setChoices(next);
                    setMode(next?.[0]?.mode);
                    setUnit('');
                    setTotal('');
                  } catch {
                    if (latest()) {
                      setChoicesUnavailable(true);
                      setAlert(m.library_progress_unavailable());
                    }
                  } finally {
                    if (latest()) setChoosing(false);
                  }
                }}
              />
            </Field>
            {alert && !choices?.length ? <p role="alert">{alert}</p> : null}
            {choicesUnavailable ? <p role="status">{m.library_progress_unavailable()}</p> : null}
            {chosen.length > 0 && !choosing && !choices?.length && !alert && !choicesUnavailable ? (
              <p role="status" className="text-muted-foreground">
                {m.library_progress_unsupported()}
              </p>
            ) : null}
            {choices?.length && !choosing ? (
              <form className="max-w-xl space-y-5" onSubmit={onStart}>
                <input type="hidden" name="idempotencyKey" value={key} />
                <input type="hidden" name="subjectId" value={subject} />
                <Field>
                  <FieldLabel>{m.library_progress_version()}</FieldLabel>
                  <ProgressPicker
                    key={episode.generation}
                    isCurrent={draftCurrent}
                    disabled={draftLocked}
                    label={m.library_progress_version()}
                    value={version}
                    onValueChange={(value) => {
                      changeDraft(() => setVersion(value));
                    }}
                  />
                  <p className="text-sm text-muted-foreground">{m.library_progress_version_scope()}</p>
                </Field>
                <dl className="space-y-2 rounded-lg border border-border p-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{m.library_progress_subject()}</dt>
                    <dd className="break-words">
                      <SelectedProgressSubject subject={chosen[0]} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.library_progress_version()}</dt>
                    <dd className="break-words">
                      {version[0] ? <SelectedProgressSubject subject={version[0]} /> : m.library_progress_no_version()}
                    </dd>
                  </div>
                </dl>
                <p className="text-sm text-muted-foreground">{m.library_progress_new_session_scope()}</p>
                <fieldset className="space-y-3">
                  <FieldLegend variant="label">{m.library_current_choices()}</FieldLegend>
                  <RadioGroup
                    name="progress-mode"
                    disabled={draftLocked}
                    value={mode}
                    onValueChange={(value) => {
                      changeDraft(() => setMode(value as ProgressMode));
                    }}
                    className="flex flex-wrap gap-x-6 gap-y-3"
                  >
                    {choices
                      ?.map((allowed) => modeChoices.find((choice) => choice.value === allowed.mode)!)
                      .map((choice) => (
                        <label key={choice.value} className="flex items-center gap-2 text-sm">
                          <RadioGroupItem value={choice.value} />
                          {choice.label()}
                        </label>
                      ))}
                  </RadioGroup>
                </fieldset>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="progress-unit">{m.library_progress_unit()}</FieldLabel>
                    <NativeSelect
                      id="progress-unit"
                      name="unit"
                      disabled={draftLocked}
                      value={unit}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        changeDraft(() => setUnit(value));
                      }}
                    >
                      {units.map((choice) => (
                        <NativeSelectOption key={choice.id} value={choice.id}>
                          {choice.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  {pair?.total !== 'forbidden' ? (
                    <Field>
                      <FieldLabel htmlFor="progress-total">{m.library_progress_total()}</FieldLabel>
                      <Input
                        id="progress-total"
                        name="total"
                        disabled={draftLocked}
                        type="number"
                        min={pair?.min}
                        max={pair?.max}
                        step={pair?.step}
                        required={pair?.total === 'required'}
                        value={total}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          changeDraft(() => setTotal(value));
                        }}
                      />
                    </Field>
                  ) : null}
                </div>
                {alert ? (
                  <p role="alert" className="rounded-lg border border-border bg-card p-3">
                    {alert}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={pending || (!!authority && !authority.permits('progress_session.create', creatable))}
                >
                  {m.library_progress_start()}
                </Button>
              </form>
            ) : null}
          </section>
        </Exposure>
      </>
    </article>
  );
}

function SelectedProgressSubject({ subject }: { subject: ProgressPickerSubject | undefined }) {
  if (!subject) return null;
  return (
    <>
      <a href={subjectHref({ id: subject.id, label: subject.title }, getLocale()).href} className="underline">
        {subject.title}
      </a>
      {subject.typeLabel ? <span className="ml-2 text-muted-foreground">{subject.typeLabel}</span> : null}
    </>
  );
}

function SessionRow({
  session: initial,
  ratio,
  sourcePage,
  authority,
}: {
  session: ProgressIndex['sessions'][number];
  ratio: CoverRatio;
  sourcePage: ProgressIndex;
  authority?: ProgressAuthority | undefined;
}) {
  const readable = useOperation('progress_session.read');
  const completable = useOperation('progress_session.complete');
  const abandonable = useOperation('progress_session.abandon');
  const admission = useRef({ completable, abandonable });
  admission.current = { completable, abandonable };
  // Only a meaningful fresh row invalidates a completion within an observed viewer lifetime.
  const identity = authority ? JSON.stringify(initial) : sourcePage;
  const nativeContext = progressRowContext(initial);
  const complete = useProgressAction(
    authority,
    'progress_session.complete',
    completable,
    identity,
    () => authority?.rowCurrent(nativeContext) !== false,
  );
  const abandon = useProgressAction(
    authority,
    'progress_session.abandon',
    abandonable,
    identity,
    () => authority?.rowCurrent(nativeContext) !== false,
  );
  const row = useProgressEpisode(identity, () => true);
  const current = (action?: 'complete' | 'abandon') =>
    row.isCurrent() &&
    authority?.isCurrent() !== false &&
    (!action ||
      (action === 'complete'
        ? complete.isCurrent() && admission.current.completable
        : abandon.isCurrent() && admission.current.abandonable));
  const intent = useRef<ProgressCommand<ProgressFinishInput, typeof finishProgressSession> | null>(null);
  const [session, setSession] = useState(initial);
  const [seenIdentity, setSeenIdentity] = useState({ identity, complete, abandon, row });
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  if (
    identity !== seenIdentity.identity ||
    complete !== seenIdentity.complete ||
    abandon !== seenIdentity.abandon ||
    row !== seenIdentity.row
  ) {
    const sameRow = identity === seenIdentity.identity;
    const action = intent.current?.data.action ?? confirming;
    const previousAction = action === 'complete' ? seenIdentity.complete : seenIdentity.abandon;
    const nextAction = action === 'complete' ? complete : abandon;
    setSeenIdentity({ identity, complete, abandon, row });
    // A sibling admission change cannot release this action's pending lease.
    if (!sameRow || row !== seenIdentity.row || (action && previousAction !== nextAction)) {
      if (!authority || previousAction.revoked) {
        intent.current = null;
        if (authority) setKey(crypto.randomUUID());
      }
      if (!sameRow) setSession(initial);
      setConfirming(intent.current?.data.action ?? null);
      setError(!!intent.current);
      setPending(false);
    }
  }
  const renderedRow = useRef(session);
  renderedRow.current = session;
  const confirmation = useRef({ value: confirming, token: {} });
  if (confirmation.current.value !== confirming) confirmation.current = { value: confirming, token: {} };
  const confirmed = confirmation.current;
  const rowCurrent = (action?: 'complete' | 'abandon') => current(action) && renderedRow.current === session;
  const confirm = (action: 'complete' | 'abandon' | null) => {
    if (!rowCurrent(action ?? undefined) || complete.pending || abandon.pending) return;
    if (confirmation.current.value === action) return;
    confirmation.current = { value: action, token: {} };
    setConfirming(action);
  };
  const progress = progressView(session, getLocale());
  async function finish(action: 'complete' | 'abandon') {
    const origin = action === 'complete' ? complete : abandon;
    if (
      !rowCurrent(action) ||
      confirmation.current !== confirmed ||
      confirmed.value !== action ||
      origin.pending ||
      (intent.current && intent.current.data.action !== action)
    )
      return;
    origin.pending = true;
    setPending(true);
    setError(false);
    try {
      const headers = authority ? authority.headers() : csrfHeaders();
      if (!headers || !rowCurrent(action)) return;
      const command = (intent.current ??= {
        data: {
          sessionId: session.id,
          revision: session.revision,
          idempotencyKey: key,
          action,
        },
        headers,
        send: finishProgressSession,
      });
      const result = await command.send({ data: command.data, headers: command.headers });
      if (!rowCurrent(action)) return;
      if (!result.ok) {
        setError(true);
        if (authority && result.reason !== 'unavailable') {
          intent.current = null;
          confirmation.current = { value: action, token: {} };
          setKey(crypto.randomUUID());
        }
        return;
      }
      if (result.session.id !== command.data.sessionId) {
        setError(true);
        return;
      }
      intent.current = null;
      confirmation.current = { value: null, token: {} };
      setSession((current) =>
        result.session.id === current.id && result.session.revision >= current.revision
          ? { ...current, ...result.session }
          : current,
      );
      setKey(crypto.randomUUID());
      setConfirming(null);
    } catch {
      if (rowCurrent(action)) setError(true);
    } finally {
      if (rowCurrent(action)) {
        origin.pending = false;
        setPending(false);
      }
    }
  }
  const title = session.subject
    ? displayLibraryTitle(session.subject.label, getLocale())
    : { text: m.library_subject_unavailable(), lang: undefined };
  return (
    <ContentItem
      title={title.text}
      {...(title.lang ? { titleLang: title.lang } : {})}
      headingLevel={2}
      {...(readable ? { href: `/${getLocale()}/library/progress/${encodeURIComponent(session.id)}` } : {})}
      visual={
        <div className="w-[72px] shrink-0 sm:w-24">
          <SubjectCover subject={session.subject} ratio={ratio} size="fill" />
        </div>
      }
      metadata={session.subject?.typeLabel}
      state={<span className="text-sm text-muted-foreground">{stateLabel(session.state)}</span>}
      preview={
        <div className="space-y-2">
          <ListRowControl>
            <ProgressRow
              value={progress?.percent == null ? null : progress.percent / 100}
              label={progress?.text ?? m.home_continue_in_progress()}
              menu={
                <Exposure
                  operation={authority && !completable ? 'progress_session.abandon' : 'progress_session.complete'}
                >
                  <ListRowControl>
                    <Menu
                      title={m.library_collection_actions()}
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label={m.library_collection_actions()}>
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      }
                      entries={[
                        ...(session.subject
                          ? [
                              {
                                type: 'link' as const,
                                label: m.library_progress_open_subject(),
                                href: subjectHref(
                                  {
                                    id: session.subject.id,
                                    label: displayLibraryTitle(session.subject.label, getLocale()).text,
                                  },
                                  getLocale(),
                                ).href,
                              },
                            ]
                          : []),
                        ...(session.state === 'active'
                          ? [
                              ...(!authority || completable
                                ? [
                                    {
                                      type: 'item' as const,
                                      label: m.library_progress_complete(),
                                      onSelect: () => {
                                        confirm('complete');
                                      },
                                    },
                                  ]
                                : []),
                              ...(!authority || abandonable
                                ? [
                                    {
                                      type: 'item' as const,
                                      label: m.library_progress_abandon(),
                                      onSelect: () => {
                                        confirm('abandon');
                                      },
                                    },
                                  ]
                                : []),
                            ]
                          : []),
                      ]}
                    />
                  </ListRowControl>
                </Exposure>
              }
            />
          </ListRowControl>
          {!session.unitLabel ? (
            <>
              <p className="text-sm text-muted-foreground">{m.library_progress_index_reader_history_unavailable()}</p>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {m.library_progress_details()}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p>{m.library_progress_unit_unspecified()}</p>
                  <p>{m.library_history_unavailable()}</p>
                  <dl>
                    <dt>
                      {m.library_progress_mode()} / {m.library_progress_unit()}
                    </dt>
                    <dd>
                      <code className="break-all">
                        {session.mode} / {session.unit}
                      </code>
                    </dd>
                  </dl>
                </div>
              </details>
            </>
          ) : null}
          {confirming ? (
            <Exposure
              operation={
                authority && confirming === 'abandon' ? 'progress_session.abandon' : 'progress_session.complete'
              }
            >
              <ListRowControl className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    pending ||
                    (!!authority &&
                      !authority.permits(
                        confirming === 'complete' ? 'progress_session.complete' : 'progress_session.abandon',
                        confirming === 'complete' ? completable : abandonable,
                      ))
                  }
                  onClick={() => void finish(confirming)}
                >
                  {confirming === 'complete'
                    ? m.library_progress_confirm_complete()
                    : m.library_progress_confirm_abandon()}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (confirmation.current === confirmed) confirm(null);
                  }}
                >
                  {m.library_progress_cancel()}
                </Button>
              </ListRowControl>
            </Exposure>
          ) : null}
          {error ? (
            <p role="alert" className="relative text-sm">
              {m.library_progress_conflict()}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
