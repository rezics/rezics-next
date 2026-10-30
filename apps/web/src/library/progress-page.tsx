import { Exposure, useOperation } from '../kernel/exposure';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel, FieldLegend } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import type { CoverRatio } from '@rezics/ui/cover';
import { EllipsisIcon } from 'lucide-react';
import { progressIndexSubjects } from './progress-subjects';
import { ProgressPicker, pickerSubject } from './progress-picker';
import { ProgressRow } from '@rezics/ui/progress-row';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Menu } from '@rezics/ui/menu';
import { Link, useRouter } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import type { ProgressIndex, ProgressMode } from './progress-reads';
import { progressView } from './progress-label';
import type { ProgressChoices } from './progress-profile';
import { finishProgressSession, startProgressSession, readProgressChoices } from './progress-server';
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

export function ProgressIndexPage({ page }: { page: ProgressIndex }) {
  const router = useRouter();
  const sessions = progressIndexSubjects(page.sessions);
  const [chosen, setChosen] = useState(() => {
    const subject = page.selectedSubject ?? sessions.find((session) => session.subject?.id === page.subjectId)?.subject;
    return subject ? [pickerSubject(subject)] : [];
  });
  const [seenSubject, setSeenSubject] = useState(page.subjectId);
  const subject = chosen[0]?.id ?? '';
  const [choices, setChoices] = useState<ProgressChoices>(page.progressChoices);
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

  if (seenSubject !== page.subjectId) {
    setSeenSubject(page.subjectId);
    setChoices(page.progressChoices);
    const next = page.selectedSubject ?? sessions.find((session) => session.subject?.id === page.subjectId)?.subject;
    setChosen(next ? [pickerSubject(next)] : []);
  }

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !mode || !pair) return;
    setAlert(null);
    setPending(true);
    const totalValue = pair.total !== 'forbidden' ? total.trim() : '';
    try {
      const result = await startProgressSession({
        data: {
          subjectId: subject.trim(),
          mode,
          unit,
          idempotencyKey: key,
          ...(totalValue ? { total: totalValue } : {}),
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setAlert(
          result.reason === 'unsupported_library_profile'
            ? m.library_progress_unsupported()
            : result.reason === 'conflict'
              ? m.library_progress_conflict()
              : m.library_progress_invalid(),
        );
        return;
      }
      setKey(crypto.randomUUID());
      window.location.assign(router.buildLocation({ to: '/library/progress/$id', params: { id: result.id } }).href);
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      setPending(false);
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
              <SessionRow key={session.id} session={session} ratio={ratio} />
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
                  const request = ++choiceRequest.current;
                  setChosen(value);
                  setChoices(undefined);
                  setChoosing(true);
                  setAlert(null);
                  try {
                    const next = value[0]
                      ? await readProgressChoices({ data: value[0].type ?? value[0].types[0] ?? '' })
                      : undefined;
                    if (request !== choiceRequest.current) return;
                    setChoices(next);
                    setMode(next?.[0]?.mode);
                    setUnit('');
                    setTotal('');
                  } catch {
                    if (request === choiceRequest.current) setAlert(m.library_progress_invalid());
                  } finally {
                    if (request === choiceRequest.current) setChoosing(false);
                  }
                }}
              />
            </Field>
            {chosen.length > 0 && !choosing && !choices?.length && !alert ? (
              <p role="status" className="text-muted-foreground">
                {m.library_progress_unsupported()}
              </p>
            ) : null}
            {choices?.length && !choosing ? (
              <form className="max-w-xl space-y-5" onSubmit={onStart}>
                <input type="hidden" name="idempotencyKey" value={key} />
                <input type="hidden" name="subjectId" value={subject} />
                <fieldset className="space-y-3">
                  <FieldLegend variant="label">{m.library_progress_mode()}</FieldLegend>
                  <RadioGroup
                    name="progress-mode"
                    value={mode}
                    onValueChange={(value) => setMode(value as ProgressMode)}
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

function SessionRow({ session: initial, ratio }: { session: ProgressIndex['sessions'][number]; ratio: CoverRatio }) {
  const readable = useOperation('progress_session.read');
  const [session, setSession] = useState(initial);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const progress = progressView(session, getLocale());
  async function finish(action: 'complete' | 'abandon') {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const result = await finishProgressSession({
        data: { sessionId: session.id, revision: session.revision, idempotencyKey: key, action },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setError(true);
        return;
      }
      setSession((current) => ({ ...current, ...result.session }));
      setKey(crypto.randomUUID());
      setConfirming(null);
    } catch {
      setError(true);
    } finally {
      setPending(false);
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
                            onSelect: () => setConfirming('complete'),
                          },
                          {
                            type: 'item' as const,
                            label: m.library_progress_abandon(),
                            onSelect: () => setConfirming('abandon'),
                          },
                        ]
                      : []),
                  ]}
                />
              </ListRowControl>
            </Exposure>
          }
        />
        {!session.inputRules ? (
          <p className="text-sm text-muted-foreground">{m.library_progress_no_longer_offered()}</p>
        ) : null}
        {confirming ? (
          <Exposure operation="progress_session.complete">
            <div className="relative z-10 flex flex-wrap gap-2">
              <Button disabled={pending} onClick={() => void finish(confirming)}>
                {confirming === 'complete'
                  ? m.library_progress_confirm_complete()
                  : m.library_progress_confirm_abandon()}
              </Button>
              <Button variant="outline" onClick={() => setConfirming(null)}>
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
