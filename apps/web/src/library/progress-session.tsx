import { Exposure } from '../kernel/exposure';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import type { ReactNode } from 'react';
import { RelativeTime } from './logs-progress';
import { ProgressRow } from '@rezics/ui/progress-row';
import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { Menu } from '@rezics/ui/menu';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Dialog, DialogContent, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { Drawer, DrawerContent, DrawerTitle } from '@rezics/ui/shadcn/drawer';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { parseUnitBatch, type ProgressChange, type ProgressSessionPage, type ProgressState } from './progress-reads';
import { finishProgressSession, recordProgressSession } from './progress-server';
import { rowRatio, SubjectCover, SubjectIdentity } from './subject-row';
import { displayLibraryTitle, LibraryTitle } from './title';
import { progressView } from './progress-label';

const buttonClass =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted';

function stateLabel(state: ProgressState): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

export function ProgressSessionPage({ page, children }: { page: ProgressSessionPage; children?: ReactNode }) {
  return <SessionEditor page={page as Extract<ProgressSessionPage, { signedIn: true }>}>{children}</SessionEditor>;
}

function SessionEditor({
  page,
  children,
}: {
  page: Extract<ProgressSessionPage, { signedIn: true }>;
  children?: ReactNode;
}) {
  const [session, setSession] = useState(page.session);
  const [seenId, setSeenId] = useState(page.session.id);
  const [key, setKey] = useState(page.idempotencyKey);
  const [amount, setAmount] = useState('');
  const [locator, setLocator] = useState('');
  const [position, setPosition] = useState('');
  const [addText, setAddText] = useState('');
  const [removeText, setRemoveText] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [editing, setEditing] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const offered = Boolean(session.inputRules) && !unsupported;
  const [phone, setPhone] = useState(false);
  const pending = useRef(false);
  const addId = useId();
  const removeId = useId();
  const addHint = useId();
  const removeHint = useId();
  const changesHeading = useId();
  const unitsHeading = useId();

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px), (pointer: coarse)');
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  function openUpdate() {
    setAmount(session.amount ?? '');
    setLocator(session.locator ?? '');
    setPosition(session.position ?? '');
    setEditing(true);
  }

  if (page.session.id !== seenId) {
    setSeenId(page.session.id);
    setUnsupported(false);
    setSession(page.session);
    setKey(page.idempotencyKey);
    setAmount('');
    setLocator('');
    setPosition('');
    setAddText('');
    setRemoveText('');
    setAlert(null);
    setConfirming(null);
  }

  function explain(reason: string) {
    setAlert(
      reason === 'unsupported_library_profile'
        ? m.library_progress_unsupported()
        : reason === 'conflict'
          ? m.library_progress_conflict()
          : m.library_progress_invalid(),
    );
    if (reason === 'unsupported_library_profile') setUnsupported(true);
  }

  async function onRecord() {
    if (pending.current || session.state !== 'active' || !offered) return;
    setAlert(null);
    const intent =
      session.mode === 'cursor_position'
        ? { locator: locator.trim(), position: position.trim() }
        : { amount: amount.trim() };
    pending.current = true;
    try {
      const result = await recordProgressSession({
        data: { sessionId: session.id, revision: session.revision, idempotencyKey: key, ...intent },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        explain(result.reason);
        return;
      }
      const change: ProgressChange = {
        id: `${session.id}:${result.session.revision}`,
        revision: result.session.revision,
        createdAt: new Date().toISOString(),
        action: null,
        amount: 'amount' in intent ? intent.amount : null,
        locator: 'locator' in intent ? intent.locator : null,
        position: 'position' in intent ? intent.position : null,
        add: [],
        remove: [],
      };
      setKey(crypto.randomUUID());
      setAmount('');
      setLocator('');
      setPosition('');
      setSession((current) => ({
        ...current,
        revision: result.session.revision,
        amount: result.session.amount,
        locator: result.session.locator,
        position: result.session.position,
        completedUnitCount: result.session.completedUnitCount,
        state: result.session.state,
        completedAt: result.session.completedAt,
        total: result.session.total,
        changes: [...current.changes, change],
      }));
      setEditing(false);
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      pending.current = false;
    }
  }

  async function onUnits(kind: 'add' | 'remove') {
    if (pending.current || session.state !== 'active' || !offered) return;
    const parsed = parseUnitBatch(kind === 'add' ? addText : removeText);
    if (!parsed.ok) {
      setAlert(parsed.reason === 'limit' ? m.library_progress_batch_limit() : m.library_progress_invalid());
      return;
    }
    setAlert(null);
    pending.current = true;
    try {
      const result = await recordProgressSession({
        data: {
          sessionId: session.id,
          revision: session.revision,
          idempotencyKey: key,
          ...(kind === 'add' ? { add: parsed.ids } : { remove: parsed.ids }),
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        explain(result.reason);
        return;
      }
      const change: ProgressChange = {
        id: `${session.id}:${result.session.revision}`,
        revision: result.session.revision,
        createdAt: new Date().toISOString(),
        action: null,
        amount: null,
        locator: null,
        position: null,
        add: kind === 'add' ? parsed.ids : [],
        remove: kind === 'remove' ? parsed.ids : [],
      };
      setKey(crypto.randomUUID());
      if (kind === 'add') setAddText('');
      else setRemoveText('');
      setSession((current) => {
        const next = new Set(current.units);
        if (kind === 'add') for (const id of parsed.ids) next.add(id);
        else for (const id of parsed.ids) next.delete(id);
        return {
          ...current,
          revision: result.session.revision,
          completedUnitCount: result.session.completedUnitCount,
          state: result.session.state,
          completedAt: result.session.completedAt,
          units: [...next].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
          changes: [...current.changes, change],
        };
      });
      setEditing(false);
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      pending.current = false;
    }
  }

  async function onFinish(action: 'complete' | 'abandon') {
    if (pending.current || session.state !== 'active') return;
    setAlert(null);
    pending.current = true;
    try {
      const result = await finishProgressSession({
        data: { sessionId: session.id, action, revision: session.revision, idempotencyKey: key },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        explain(result.reason);
        return;
      }
      setKey(crypto.randomUUID());
      setConfirming(null);
      const change: ProgressChange = {
        id: `${session.id}:${result.session.revision}`,
        revision: result.session.revision,
        createdAt: new Date().toISOString(),
        action,
        amount: null,
        locator: null,
        position: null,
        add: [],
        remove: [],
      };
      setSession((current) => ({
        ...current,
        revision: result.session.revision,
        amount: result.session.amount,
        state: result.session.state,
        completedAt: result.session.completedAt,
        changes: [...current.changes, change],
      }));
    } catch {
      setAlert(m.library_progress_invalid());
    } finally {
      pending.current = false;
    }
  }

  const { min, max, step } = session.inputRules ?? {};
  const inputBounds = { min, max, step };
  const ratio = rowRatio([session.subject, session.versionSubjectId ? session.versionSubject : session.subject]);
  const progress = progressView(session, getLocale());
  const recordForm = (
    <Exposure operation="progress_session.record">
      <section aria-labelledby="record-progress-heading" className="space-y-4">
        <h2 id="record-progress-heading" className="text-xl font-semibold">
          {m.library_progress_record_heading()}
        </h2>
        {session.state !== 'active' ? <p className="text-muted-foreground">{stateLabel(session.state)}</p> : null}
        {offered && session.state === 'active' && session.mode !== 'completed_units' ? (
          <form
            className="max-w-xl space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onRecord();
            }}
          >
            {session.mode === 'scalar_amount' ? (
              <label className="block space-y-1">
                <span className="text-sm font-medium">{m.library_progress_amount()}</span>
                <Input
                  type="number"
                  {...inputBounds}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
            ) : (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{m.library_progress_locator()}</span>
                  <Input value={locator} onChange={(event) => setLocator(event.target.value)} />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{m.library_progress_position()}</span>
                  <Input
                    type="number"
                    {...inputBounds}
                    value={position}
                    onChange={(event) => setPosition(event.target.value)}
                  />
                </label>
              </>
            )}
            <Button type="submit">{m.library_progress_record()}</Button>
          </form>
        ) : null}
        {offered && session.state === 'active' && session.mode === 'completed_units' ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor={addId} className="text-sm font-medium">
                {m.library_progress_add_units()}
              </label>
              <Textarea
                id={addId}
                aria-describedby={addHint}
                value={addText}
                onChange={(event) => setAddText(event.target.value)}
              />
              <p id={addHint} className="text-sm text-muted-foreground">
                {m.library_progress_batch_limit()}
              </p>
              <Button variant="outline" onClick={() => void onUnits('add')}>
                {m.library_progress_add_units()}
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor={removeId} className="text-sm font-medium">
                {m.library_progress_remove_units()}
              </label>
              <Textarea
                id={removeId}
                aria-describedby={removeHint}
                value={removeText}
                onChange={(event) => setRemoveText(event.target.value)}
              />
              <p id={removeHint} className="text-sm text-muted-foreground">
                {m.library_progress_batch_limit()}
              </p>
              <Button variant="outline" onClick={() => void onUnits('remove')}>
                {m.library_progress_remove_units()}
              </Button>
            </div>
          </div>
        ) : null}
        {session.state === 'active' && confirming ? (
          <div className="flex flex-wrap gap-3">
            {confirming === 'complete' ? (
              <Button variant="outline" onClick={() => void onFinish('complete')}>
                {m.library_progress_confirm_complete()}
              </Button>
            ) : null}
            {confirming === 'abandon' ? (
              <Button variant="outline" onClick={() => void onFinish('abandon')}>
                {m.library_progress_confirm_abandon()}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {m.library_progress_cancel()}
            </Button>
          </div>
        ) : session.state !== 'active' ? (
          <p>
            <a
              href={`/${getLocale()}/library/progress?subjectId=${encodeURIComponent(session.subjectId)}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {m.library_progress_restart()}
            </a>
          </p>
        ) : null}
      </section>
    </Exposure>
  );

  return (
    <article className="max-w-4xl space-y-10 text-foreground">
      <header className="space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <div className="flex items-start gap-5 sm:gap-7">
          <div className="w-24 shrink-0 sm:w-40">
            <SubjectCover subject={session.subject} ratio={ratio} size="fill" priority />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1">
              <p className="work-title text-2xl font-medium sm:text-3xl">
                {session.subject ? (
                  <Link
                    to={
                      subjectHref(
                        { id: session.subject.id, label: displayLibraryTitle(session.subject.label, getLocale()).text },
                        getLocale(),
                      ).to
                    }
                    params={
                      subjectHref(
                        { id: session.subject.id, label: displayLibraryTitle(session.subject.label, getLocale()).text },
                        getLocale(),
                      ).params
                    }
                    className="underline-offset-4 hover:underline"
                  >
                    <LibraryTitle label={session.subject.label} locale={getLocale()} />
                  </Link>
                ) : (
                  m.library_subject_unavailable()
                )}
              </p>
              {session.subject?.typeLabel ? (
                <p className="text-sm text-muted-foreground">{session.subject.typeLabel}</p>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              <span data-progress-state={session.state}>{stateLabel(session.state)}</span>
            </p>
            <ProgressRow
              value={progress?.percent == null ? null : progress.percent / 100}
              label={progress?.text ?? m.home_continue_in_progress()}
            />
            {session.total && session.mode === 'scalar_amount' && session.amount === null ? (
              <p className="text-sm text-muted-foreground">
                {m.library_progress_total()}: {session.total}
              </p>
            ) : null}
          </div>
        </div>
        {session.versionSubjectId ? <SubjectIdentity subject={session.versionSubject} ratio={ratio} /> : null}
      </header>
      {!session.inputRules ? (
        <p className="text-sm text-muted-foreground">{m.library_progress_no_longer_offered()}</p>
      ) : null}
      {session.state === 'active' ? (
        <div className="flex items-center gap-2">
          {offered ? <Button onClick={openUpdate}>{m.library_progress_update()}</Button> : null}
          <Exposure operation="progress_session.complete">
            <Menu
              title={m.library_collection_actions()}
              trigger={
                <Button variant="ghost" className="min-h-10 px-3" aria-label={m.library_collection_actions()}>
                  {m.library_collection_actions()}
                </Button>
              }
              entries={[
                { type: 'item', label: m.library_progress_complete(), onSelect: () => setConfirming('complete') },
                { type: 'item', label: m.library_progress_abandon(), onSelect: () => setConfirming('abandon') },
              ]}
            />
          </Exposure>
        </div>
      ) : null}
      {session.state === 'active' && confirming && !editing ? (
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void onFinish(confirming)}>
            {confirming === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon()}
          </Button>
          <Button variant="outline" onClick={() => setConfirming(null)}>
            {m.library_progress_cancel()}
          </Button>
        </div>
      ) : null}
      {editing ? (
        phone ? (
          <Drawer open={editing} onOpenChange={setEditing}>
            <DrawerContent>
              <div className="max-h-[85dvh] overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <DrawerTitle>{m.library_progress_update()}</DrawerTitle>
                <input type="hidden" name="idempotencyKey" value={key} />
                {alert ? (
                  <p role="alert" className="rounded-lg border border-border bg-card p-3">
                    {alert}
                  </p>
                ) : null}
                {offered ? recordForm : null}
              </div>
            </DrawerContent>
          </Drawer>
        ) : (
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto">
              <DialogTitle>{m.library_progress_update()}</DialogTitle>
              <input type="hidden" name="idempotencyKey" value={key} />
              {alert ? (
                <p role="alert" className="rounded-lg border border-border bg-card p-3">
                  {alert}
                </p>
              ) : null}
              {offered ? recordForm : null}
            </DialogContent>
          </Dialog>
        )
      ) : null}
      <section role="region" aria-labelledby={changesHeading} className="space-y-3">
        <h2 id={changesHeading} className="text-xl font-semibold">
          {m.library_progress_changes()}
        </h2>
        {session.changes.length ? (
          <ol className="space-y-3">
            {session.changes.map((change) => (
              <ListRow key={change.id} className="py-3">
                <div className="mb-2 text-sm text-muted-foreground">
                  <RelativeTime value={change.createdAt} />
                </div>
                {change.action ? (
                  <p>{stateLabel(change.action === 'complete' ? 'completed' : 'abandoned')}</p>
                ) : (
                  <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                    {[
                      [m.library_progress_amount(), change.amount],
                      [m.library_progress_locator(), change.locator],
                      [m.library_progress_position(), change.position],
                      [m.library_progress_add_units(), change.add.join(', ')],
                      [m.library_progress_remove_units(), change.remove.join(', ')],
                    ]
                      .filter(([, value]) => value != null && value !== '')
                      .map(([label, value]) => (
                        <div key={label} className="space-y-1">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="break-words">{value}</dd>
                        </div>
                      ))}
                  </dl>
                )}
              </ListRow>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">{m.library_progress_changes_empty()}</p>
        )}
        {session.changesNext ? (
          <Exposure operation="progress_session.changes">
            <Link
              to="/library/progress/$id"
              params={{ id: session.id }}
              search={{
                changes: session.changesNext,
                ...(page.unitsCursor ? { units: page.unitsCursor } : {}),
              }}
              className={buttonClass}
            >
              {m.library_progress_more()}
            </Link>
          </Exposure>
        ) : null}
      </section>
      <section role="region" aria-labelledby={unitsHeading} className="space-y-3">
        <h2 id={unitsHeading} className="text-xl font-semibold">
          {m.library_progress_units()}
        </h2>
        {session.units.length ? (
          <ul className="space-y-3">
            {session.units.map((unit) => (
              <ListRow key={unit} className="py-2">
                {unit}
              </ListRow>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.library_progress_units_empty()}</p>
        )}
        {session.unitsNext ? (
          <Exposure operation="progress_session.units">
            <Link
              to="/library/progress/$id"
              params={{ id: session.id }}
              search={{
                units: session.unitsNext,
                ...(page.changesCursor ? { changes: page.changesCursor } : {}),
              }}
              className={buttonClass}
            >
              {m.library_progress_more()}
            </Link>
          </Exposure>
        ) : null}
      </section>
      {children}
    </article>
  );
}
