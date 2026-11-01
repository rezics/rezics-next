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
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Link, useRouter } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
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
import { displayLibraryTitle, LibraryTitle } from './title';

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
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

type ProgressAuthority = { key: unknown; isCurrent: () => boolean };
type PageLifetime = { identity: unknown; pending: boolean };

function usePageLifetime(identity: unknown) {
  const lifetime = useRef<PageLifetime | null>(null);
  if (lifetime.current?.identity !== identity) lifetime.current = { identity, pending: false };
  useLayoutEffect(() => {
    const origin = (lifetime.current ??= { identity, pending: false });
    return () => {
      if (lifetime.current === origin) lifetime.current = null;
    };
  }, [identity]);
  return lifetime;
}

const subscribe = () => () => {};

/** Mounted by the real route: loader provenance is authority only for SSR/initial hydration. */
export function CurrentViewerProgressIndexPage({
  loader,
  requested,
}: {
  loader: CurrentViewerProgressIndex;
  requested: { subjectId?: string; cursor?: string };
}) {
  const session = useSession();
  const admitted = useOperation('progress_session.list');
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = getLocale();
  const subjectId = requested.subjectId || '';
  const cursor = requested.cursor || null;
  const viewer = hydrated ? (session.state === 'signed-in' ? (session.subject ?? null) : null) : loader.viewer;
  const allowed = hydrated ? admitted : loader.page.signedIn;
  const scope = JSON.stringify([viewer, allowed, subjectId, cursor, locale]);
  const observed = useRef<{ scope: string; generation: number; mounted: boolean } | null>(null);
  if (observed.current?.scope !== scope) {
    observed.current = { scope, generation: (observed.current?.generation ?? 0) + 1, mounted: true };
  }
  const origin = observed.current;
  useLayoutEffect(() => {
    origin.mounted = true;
    return () => {
      origin.mounted = false;
    };
  }, [origin]);
  const matches = (result: CurrentViewerProgressIndex | undefined) =>
    !!viewer &&
    allowed &&
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
  const query = useQuery({
    ...personalRead,
    queryKey: ['library', 'progress', 'current-viewer', viewer, allowed, subjectId, cursor, locale, origin.generation],
    queryFn: () =>
      readCurrentViewerProgressIndex({
        data: {
          ...(subjectId ? { subjectId } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }),
    enabled: personalRead.enabled && hydrated && !!viewer && allowed,
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
      if (matches(loader)) latest.current.result = loader;
    }
    if (latest.current.query !== query.data) {
      latest.current.query = query.data;
      latest.current.result = query.data;
    }
  }
  const result = hydrated ? latest.current.result : loader;
  if (!matches(result)) return <PageHeading>{m.library_progress_heading()}</PageHeading>;
  return (
    <ProgressIndexPage
      key={origin.generation}
      page={result!.page}
      authority={{ key: origin, isCurrent: () => observed.current === origin && origin.mounted }}
    />
  );
}

export function ProgressIndexPage({ page, authority }: { page: ProgressIndex; authority?: ProgressAuthority }) {
  const router = useRouter();
  const identity = authority?.key ?? page;
  const lifetime = usePageLifetime(identity);
  const creatable = useOperation('progress_session.create');
  const admission = useRef(creatable);
  admission.current = creatable;
  const current = (origin: PageLifetime | null): origin is PageLifetime =>
    !!origin &&
    lifetime.current === origin &&
    origin.identity === identity &&
    authority?.isCurrent() !== false &&
    admission.current;
  const intent = useRef<ProgressStartInput | null>(null);
  const sessions = progressIndexSubjects(page.sessions);
  const [chosen, setChosen] = useState(() => {
    const subject = page.selectedSubject;
    return subject ? [pickerSubject(subject)] : [];
  });
  const [seenIdentity, setSeenIdentity] = useState(identity);
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

  if (seenIdentity !== identity) {
    setSeenIdentity(identity);
    intent.current = null;
    setChoices(page.progressChoices);
    setChoicesUnavailable(page.choicesUnavailable ?? false);
    choiceRequest.current++;
    setChoosing(false);
    setVersion([]);
    setTotal('');
    setUnit('');
    setMode(page.progressChoices?.[0]?.mode);
    setKey(page.idempotencyKey);
    setAlert(null);
    setPending(false);
    const next = page.selectedSubject;
    setChosen(next ? [pickerSubject(next)] : []);
  }

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const origin = lifetime.current;
    if (!current(origin) || origin.pending || (!intent.current && (!mode || !pair))) return;
    origin.pending = true;
    setAlert(null);
    setPending(true);
    const totalValue = pair?.total !== 'forbidden' ? total.trim() : '';
    const payload = (intent.current ??= {
      subjectId: subject.trim(),
      ...(version[0] ? { versionSubjectId: version[0].id } : {}),
      mode: mode!,
      unit,
      idempotencyKey: key,
      ...(totalValue ? { total: totalValue } : {}),
    });
    try {
      const result = await startProgressSession({ data: payload, headers: csrfHeaders() });
      if (!current(origin)) return;
      if (!result.ok) {
        setAlert(progressFailureMessage(result.reason));
        if (authority && result.reason !== 'unavailable') {
          intent.current = null;
          setKey(crypto.randomUUID());
        }
        return;
      }
      setKey(crypto.randomUUID());
      window.location.assign(router.buildLocation({ to: '/library/progress/$id', params: { id: result.id } }).href);
    } catch {
      if (current(origin)) setAlert(m.library_progress_unavailable());
    } finally {
      if (current(origin)) {
        origin.pending = false;
        setPending(false);
      }
    }
  }

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
          <p className="text-muted-foreground">{m.library_progress_empty()}</p>
        )}
        {page.next ? (
          <Exposure operation="progress_session.list">
            <nav>
              <Link
                to="/library/progress"
                search={{ subjectId: page.subjectId, cursor: page.next }}
                className={buttonClass}
              >
                {m.library_progress_more()}
              </Link>
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
                value={chosen}
                onValueChange={async (value) => {
                  const origin = lifetime.current;
                  if (!current(origin)) return;
                  const request = ++choiceRequest.current;
                  const latest = () => current(origin) && request === choiceRequest.current;
                  setChosen(value);
                  setVersion([]);
                  setTotal('');
                  setChoices(undefined);
                  setChoicesUnavailable(false);
                  setChoosing(true);
                  setAlert(null);
                  try {
                    const next = value[0]
                      ? await readProgressChoices({ data: value[0].type ?? value[0].types[0] ?? '' })
                      : undefined;
                    if (!latest()) return;
                    setChoices(next);
                    setMode(next?.[0]?.mode);
                    setUnit('');
                    setTotal('');
                  } catch {
                    if (latest()) setAlert(m.library_progress_unavailable());
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
                    label={m.library_progress_version()}
                    value={version}
                    onValueChange={(value) => {
                      if (current(lifetime.current)) setVersion(value);
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
                    value={mode}
                    onValueChange={(value) => {
                      if (current(lifetime.current)) setMode(value as ProgressMode);
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
                      value={unit}
                      onChange={(event) => setUnit(event.currentTarget.value)}
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
                        type="number"
                        min={pair?.min}
                        max={pair?.max}
                        step={pair?.step}
                        required={pair?.total === 'required'}
                        value={total}
                        onChange={(event) => setTotal(event.target.value)}
                      />
                    </Field>
                  ) : null}
                </div>
                {alert ? (
                  <p role="alert" className="rounded-lg border border-border bg-card p-3">
                    {alert}
                  </p>
                ) : null}
                <Button type="submit" disabled={pending}>
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
  const lifetime = usePageLifetime(identity);
  const current = (origin: PageLifetime | null, action?: 'complete' | 'abandon'): origin is PageLifetime =>
    !!origin &&
    lifetime.current === origin &&
    origin.identity === identity &&
    authority?.isCurrent() !== false &&
    (!action || (action === 'complete' ? admission.current.completable : admission.current.abandonable));
  const intent = useRef<ProgressFinishInput | null>(null);
  const [session, setSession] = useState(initial);
  const [seenIdentity, setSeenIdentity] = useState(identity);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  if (identity !== seenIdentity) {
    setSeenIdentity(identity);
    if (!authority) intent.current = null;
    setSession(initial);
    setConfirming(authority ? (intent.current?.action ?? null) : null);
    setError(!!authority && !!intent.current);
    setPending(false);
  }
  const progress = progressView(session, getLocale());
  async function finish(action: 'complete' | 'abandon') {
    const origin = lifetime.current;
    if (!current(origin, action) || origin.pending || (intent.current && intent.current.action !== action)) return;
    origin.pending = true;
    setPending(true);
    setError(false);
    try {
      const payload = (intent.current ??= {
        sessionId: session.id,
        revision: session.revision,
        idempotencyKey: key,
        action,
      });
      const result = await finishProgressSession({
        data: payload,
        headers: csrfHeaders(),
      });
      if (!current(origin, action)) return;
      if (!result.ok) {
        setError(true);
        if (authority && result.reason !== 'unavailable') {
          intent.current = null;
          setKey(crypto.randomUUID());
        }
        return;
      }
      intent.current = null;
      setSession((current) =>
        result.session.id === current.id && result.session.revision >= current.revision
          ? { ...current, ...result.session }
          : current,
      );
      setKey(crypto.randomUUID());
      setConfirming(null);
    } catch {
      if (current(origin, action)) setError(true);
    } finally {
      if (current(origin, action)) {
        origin.pending = false;
        setPending(false);
      }
    }
  }
  return (
    <ListRow className="flex items-start gap-4 py-5 sm:gap-5">
      <div className="w-[72px] shrink-0 sm:w-24">
        <SubjectCover subject={session.subject} ratio={ratio} size="fill" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          {readable ? (
            <>
              <ListRowLink href={`/${getLocale()}/library/progress/${encodeURIComponent(session.id)}`}>
                {session.subject ? (
                  <LibraryTitle label={session.subject.label} locale={getLocale()} />
                ) : (
                  m.library_subject_unavailable()
                )}
              </ListRowLink>
              <span className="line-clamp-2 text-lg font-medium">
                {session.subject ? (
                  <LibraryTitle label={session.subject.label} locale={getLocale()} />
                ) : (
                  m.library_subject_unavailable()
                )}
              </span>
            </>
          ) : (
            <span className="line-clamp-2 text-lg font-medium">
              {session.subject ? (
                <LibraryTitle label={session.subject.label} locale={getLocale()} />
              ) : (
                m.library_subject_unavailable()
              )}
            </span>
          )}
          {session.subject?.typeLabel ? (
            <p className="text-sm text-muted-foreground">{session.subject.typeLabel}</p>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{stateLabel(session.state)}</p>
        <ProgressRow
          value={progress?.percent == null ? null : progress.percent / 100}
          label={progress?.text ?? m.home_continue_in_progress()}
          menu={
            <Exposure operation="progress_session.complete">
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
                          {
                            type: 'item' as const,
                            label: m.library_progress_complete(),
                            onSelect: () => {
                              if (current(lifetime.current, 'complete')) setConfirming('complete');
                            },
                          },
                          {
                            type: 'item' as const,
                            label: m.library_progress_abandon(),
                            onSelect: () => {
                              if (current(lifetime.current, 'abandon')) setConfirming('abandon');
                            },
                          },
                        ]
                      : []),
                  ]}
                />
              </ListRowControl>
            </Exposure>
          }
        />
        {!session.unitLabel ? (
          <p className="text-sm text-muted-foreground">
            {m.library_history_unavailable()}{' '}
            <code>
              {session.mode} / {session.unit}
            </code>
          </p>
        ) : null}
        {confirming ? (
          <Exposure operation="progress_session.complete">
            <div className="relative z-10 flex flex-wrap gap-2">
              <Button disabled={pending} onClick={() => void finish(confirming)}>
                {confirming === 'complete'
                  ? m.library_progress_confirm_complete()
                  : m.library_progress_confirm_abandon()}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (current(lifetime.current)) setConfirming(null);
                }}
              >
                {m.library_progress_cancel()}
              </Button>
            </div>
          </Exposure>
        ) : null}
        {error ? (
          <p role="alert" className="relative text-sm">
            {m.library_progress_conflict()}
          </p>
        ) : null}
      </div>
    </ListRow>
  );
}
