import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import type { CoverRatio } from '@rezics/ui/cover';
import { EllipsisIcon } from 'lucide-react';
import { progressIndexSubjects } from './progress-subjects';
import { ProgressPicker, pickerSubject } from './progress-picker';
import { ProgressRow } from '@rezics/ui/progress-row';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt, csrfHeaders } from '../threads/composer';
import type { ProgressIndex, ProgressMode, ProgressUnit } from './progress-reads';
import { finishProgressSession, startProgressSession } from './progress-server';
import { rowRatio, SubjectCover } from './subject-row';

const modeChoices: { value: ProgressMode; label: () => string }[] = [
  { value: 'scalar_amount', label: () => m.library_progress_mode_amount() },
  { value: 'cursor_position', label: () => m.library_progress_mode_cursor() },
  { value: 'completed_units', label: () => m.library_progress_mode_units() },
];

const unitChoices: { value: ProgressUnit; label: () => string }[] = [
  { value: 'page', label: () => m.library_progress_unit_page() },
  { value: 'chapter', label: () => m.library_progress_unit_chapter() },
  { value: 'episode', label: () => m.library_progress_unit_episode() },
  { value: 'volume', label: () => m.library_progress_unit_volume() },
  { value: 'minute', label: () => m.library_progress_unit_minute() },
  { value: 'percent', label: () => m.library_progress_unit_percent() },
];

function unitLabel(unit: ProgressUnit): string {
  return unitChoices.find((choice) => choice.value === unit)?.label() ?? m.library_progress_unit_page();
}

function stateLabel(state: ProgressIndex['sessions'][number]['state']): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

export function progressValue(session: ProgressIndex['sessions'][number]): { value: number | null; label: string } {
  const amount =
    session.mode === 'completed_units'
      ? String(session.completedUnitCount)
      : session.mode === 'cursor_position'
        ? session.position
        : session.amount;
  if (amount == null || amount === '') return { value: null, label: '' };
  if (session.unit === 'percent') return { value: Number(amount) / 100, label: `${amount}%` };
  if (!session.total || Number(session.total) <= 0 || !Number.isFinite(Number(amount)))
    return { value: null, label: amount };
  const prefixes: Record<ProgressUnit, string> = {
    page: 'p.',
    episode: 'Ep',
    chapter: 'Ch',
    volume: 'Vol',
    minute: 'min',
    percent: '%',
  };
  return {
    value: Number(amount) / Number(session.total),
    label: `${getLocale() === 'en' ? prefixes[session.unit] : unitLabel(session.unit)} ${amount}/${session.total}`,
  };
}

const fieldClass = 'w-full rounded-lg border border-border bg-background px-3 py-2';
const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

const subscribe = () => () => {};

export function ProgressIndexPage({ page }: { page: ProgressIndex }) {
  const router = useRouter();
  const location = useLocation();
  const sessions = progressIndexSubjects(page.sessions);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const [chosen, setChosen] = useState(() => {
    const subject = sessions.find((session) => session.subject?.id === page.subjectId)?.subject;
    return subject ? [pickerSubject(subject)] : [];
  });
  const [seenSubject, setSeenSubject] = useState(page.subjectId);
  if (seenSubject !== page.subjectId) {
    setSeenSubject(page.subjectId);
    const next = sessions.find((session) => session.subject?.id === page.subjectId)?.subject;
    setChosen(next ? [pickerSubject(next)] : []);
  }
  const subject = chosen[0]?.id ?? '';
  const [mode, setMode] = useState<ProgressMode>('scalar_amount');
  const [unit, setUnit] = useState<ProgressUnit>('page');
  const [total, setTotal] = useState('');
  const [key, setKey] = useState(page.idempotencyKey);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAlert(null);
    setPending(true);
    const totalValue = mode === 'scalar_amount' ? total.trim() : '';
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
        setAlert(result.reason === 'conflict' ? m.library_progress_conflict() : m.library_progress_invalid());
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

  const ratio = rowRatio(page.signedIn ? sessions.map((session) => session.subject) : []);
  return (
    <article className="max-w-4xl space-y-10 text-foreground">
      <PageHeading>{m.library_progress_heading()}</PageHeading>
      {page.signedIn ? (
        <>
          {sessions.length ? (
            <ol className="divide-y divide-border/60 border-y border-border/60">
              {sessions.map((session) => (
                <SessionRow key={session.id} session={session} ratio={ratio} />
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">{m.library_progress_empty()}</p>
          )}
          {page.next ? (
            <nav>
              <Link
                to="/library/progress"
                search={{ subjectId: page.subjectId, cursor: page.next }}
                className={buttonClass}
              >
                {m.library_progress_more()}
              </Link>
            </nav>
          ) : null}
          <section aria-labelledby="start-progress-heading" className="space-y-5">
            <h2 id="start-progress-heading" className="text-xl font-semibold">
              {m.library_progress_start_heading()}
            </h2>
            <form className="max-w-xl space-y-5" onSubmit={onStart}>
              <input type="hidden" name="idempotencyKey" value={key} />
              {hydrated ? (
                <>
                  <input type="hidden" name="subjectId" value={subject} />
                  <div className="space-y-2">
                    <span className="text-sm font-medium">{m.library_progress_subject()}</span>
                    <ProgressPicker value={chosen} onValueChange={setChosen} />
                  </div>
                </>
              ) : (
                <label className="block space-y-2">
                  <span className="text-sm font-medium">{m.library_progress_subject()}</span>
                  <Input name="subjectId" defaultValue={page.subjectId} />
                </label>
              )}
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{m.library_progress_mode()}</legend>
                <RadioGroup
                  name="progress-mode"
                  value={mode}
                  onValueChange={(value) => setMode(value as ProgressMode)}
                  className="flex flex-wrap gap-x-6 gap-y-3"
                >
                  {modeChoices.map((choice) => (
                    <label key={choice.value} className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value={choice.value} />
                      {choice.label()}
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="progress-unit">{m.library_progress_unit()}</Label>
                  {hydrated ? (
                    <Select
                      value={unit}
                      onValueChange={(value) => {
                        if (value) setUnit(value as ProgressUnit);
                      }}
                    >
                      <SelectTrigger id="progress-unit" className="w-full">
                        <SelectValue>{unitLabel(unit)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {unitChoices.map((choice) => (
                          <SelectItem key={choice.value} value={choice.value}>
                            {choice.label()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <select id="progress-unit" name="unit" className={fieldClass} defaultValue={unit}>
                      {unitChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label()}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <label className="block space-y-2">
                  <span className="text-sm font-medium">{m.library_progress_total()}</span>
                  <Input
                    name="total"
                    type="number"
                    min="0"
                    step="any"
                    value={total}
                    disabled={mode !== 'scalar_amount'}
                    onChange={(event) => setTotal(event.target.value)}
                  />
                </label>
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
          </section>
        </>
      ) : (
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0] ?? location.pathname} />
      )}
    </article>
  );
}

function SessionRow({ session: initial, ratio }: { session: ProgressIndex['sessions'][number]; ratio: CoverRatio }) {
  const [session, setSession] = useState(initial);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
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
    <li className="relative flex items-start gap-4 py-5 sm:gap-5">
      <div className="w-12 shrink-0 sm:w-24">
        <SubjectCover subject={session.subject} ratio={ratio} size="fill" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <Link
            to="/library/progress/$id"
            params={{ id: session.id }}
            className="work-title line-clamp-2 text-lg font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {session.subject?.label ?? m.library_subject_unavailable()}
          </Link>
          {session.subject?.typeLabel ? (
            <p className="text-sm text-muted-foreground">{session.subject.typeLabel}</p>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {stateLabel(session.state)} · {unitLabel(session.unit)}
        </p>
        <ProgressRow
          {...progressValue(session)}
          menu={
            <DropdownMenu>
              <DropdownMenuTrigger
                className="relative z-10"
                render={<Button variant="ghost" size="icon-sm" aria-label={m.library_collection_actions()} />}
              >
                <EllipsisIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {session.subject ? (
                  <DropdownMenuItem render={<Link to="/subjects/$id" params={{ id: session.subject.id }} />}>
                    {m.library_progress_open_subject()}
                  </DropdownMenuItem>
                ) : null}
                {session.state === 'active' ? (
                  <>
                    <DropdownMenuItem onClick={() => setConfirming('complete')}>
                      {m.library_progress_complete()}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setConfirming('abandon')}>
                      {m.library_progress_abandon()}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        {confirming ? (
          <div className="relative z-10 flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => void finish(confirming)}>
              {confirming === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon()}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {m.library_progress_cancel()}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="relative text-sm">
            {m.library_progress_conflict()}
          </p>
        ) : null}
      </div>
    </li>
  );
}
