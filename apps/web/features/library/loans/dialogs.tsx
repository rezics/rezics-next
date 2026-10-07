'use client';

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader }
  from '@rezics/ui/alert-dialog';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/radio-group';
import { materializeData } from 'native-i18n';
import { useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import type { LibraryMessages } from '../messages.ts';
import { formatDay, today } from '../format.ts';
import { useCopiesApi } from './provider.tsx';
import { dayInstant, dueDay, dueInstant, instantFromLocal, laterDay, localInput } from './format.ts';
import { handleText, partyFromInput } from './party.ts';
import { extendedLoanMatches, openedLoanMatches, returnedLoanMatches } from './intent.ts';
import { recordContinuation, reduceRecordPage, type RecordList } from './paging.ts';
import { recordOwnedCopy } from './record.ts';
import type { CopyRecord, LibraryParty, LoanRecord, RecordFailure, RecordResult, ReleaseChoice } from './types.ts';
import type { CopiesApi } from './api.ts';
import { commandInstance, submitRecord, writeNewest } from './write.ts';

type T = ReturnType<typeof materializeData<LibraryMessages>>;
type PartyMode = 'name' | 'person';

const emptyList = { items: [], nextCursor: null, failed: false };

function MoreRecords({ mode, busy, failedText, moreLabel, retryLabel, onMore }: {
  mode: 'more' | 'retry' | null; busy: boolean; failedText: string; moreLabel: string; retryLabel: string;
  onMore: () => void;
}) {
  if (!mode) return null;
  return <div className="flex flex-wrap items-center gap-2">
    {mode === 'retry' ? <p role="alert" className="text-destructive-foreground text-xs">{failedText}</p> : null}
    <Button type="button" variant="outline" size="sm" aria-busy={busy || undefined} disabled={busy} onClick={onMore}>
      {mode === 'retry' ? retryLabel : moreLabel}</Button>
    </div>;
}

/** Release pages after the ones already listed, until every loaded copy's edition is named or the list ends. */
async function fillEditions(api: CopiesApi, work: string, held: RecordList<ReleaseChoice>, needed: ReadonlySet<string>):
  Promise<RecordList<ReleaseChoice>> {
  let list = held;
  const seen = new Set<string>();
  for (let page = 0; page < 30; page++) {
    const missing = [...needed].some(id => !list.items.some(item => item.id === id));
    if (!missing || !list.nextCursor || seen.has(list.nextCursor)) return list;
    seen.add(list.nextCursor);
    const read = await api.releases(work, list.nextCursor);
    list = reduceRecordPage(list, read);
    if (!read.ok) return list;
  }
  return list;
}

function editionLabel(release: ReleaseChoice): string {
  const detail = [release.editionStatement, release.publicationYear, release.isbn13].filter(part => part != null)
    .join(' · ');
  return detail ? `${release.title} — ${detail}` : release.title;
}

function failureText(failure: RecordFailure, t: T, copy: boolean): string {
  if (failure === 'moved') return t.loanMoved;
  if (failure === 'conflict') return t.loanConflict;
  return copy ? t.copyFailed : t.loanFailed;
}

function PartyFields({ legend, mode, name, handle, onMode, onName, onHandle, t }: {
  legend: string; mode: PartyMode; name: string; handle: string;
  onMode: (mode: PartyMode) => void; onName: (name: string) => void; onHandle: (handle: string) => void; t: T;
}) {
  const nameId = useId();
  return <fieldset className="grid min-w-0 gap-3">
    <legend className="font-medium text-sm">{legend}</legend>
    <RadioGroup value={mode} onValueChange={({ value }) => { if (value === 'name' || value === 'person') onMode(value); }}
      aria-label={legend} className="gap-2">
      <RadioGroupItem value="name">{t.partyName}</RadioGroupItem>
      <RadioGroupItem value="person">{t.partyPerson}</RadioGroupItem>
    </RadioGroup>
    {mode === 'name'
      ? <Field>
        <FieldLabel htmlFor={nameId}>{t.partyNameLabel}</FieldLabel>
        <Input id={nameId} value={name} maxLength={300} autoComplete="off" onChange={event => onName(event.currentTarget.value)} />
        <FieldDescription>{t.partyNameHelp}</FieldDescription>
      </Field>
      : <Field>
        <FieldLabel htmlFor={nameId}>{t.personHandle}</FieldLabel>
        <Input id={nameId} value={handle} maxLength={64} autoComplete="off" placeholder={t.personHandlePlaceholder}
          onChange={event => onHandle(event.currentTarget.value)} />
        <FieldDescription>{t.personHandleHelp}</FieldDescription>
      </Field>}
  </fieldset>;
}

async function chosenParty(api: ReturnType<typeof useCopiesApi>, mode: PartyMode, name: string, handle: string,
  required: boolean, t: T, setError: (error: string) => void): Promise<LibraryParty | null | 'invalid'> {
  if (mode === 'name') {
    const party = partyFromInput({ mode: 'name', name, personId: null });
    if (!party && required) { setError(t.nameRequired); return 'invalid'; }
    return party;
  }
  const typed = handleText(handle);
  if (!typed) {
    if (required) setError(t.personRequired);
    return required ? 'invalid' : null;
  }
  const found = await api.person(typed);
  if (!found.ok || !found.data) { setError(t.personUnavailable); return 'invalid'; }
  if (found.data.kind !== 'person') { setError(t.personNotPerson); return 'invalid'; }
  return partyFromInput({ mode: 'person', name: '', personId: found.data.id });
}

export function CopyDialog({ work, title, open, onOpenChange, locale, messages, onSaved }: {
  work: string; title: string; open: boolean; onOpenChange: (open: boolean) => void; locale: UiLocale;
  messages: LibraryMessages; onSaved: (copy: CopyRecord) => void;
}) {
  const t = materializeData(messages, { locale });
  const api = useCopiesApi();
  const [editions, setEditions] = useState<RecordList<ReleaseChoice>>(emptyList);
  const [release, setRelease] = useState('');
  const [format, setFormat] = useState('');
  const [mode, setMode] = useState<PartyMode>('name');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [acquiredOn, setAcquiredOn] = useState('');
  const [ownedSince, setOwnedSince] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const command = useRef(commandInstance());
  const releases = editions.items;

  useEffect(() => {
    if (!open) return;
    const ticket = ++generation.current;
    setLoading(true);
    setMoreBusy(false);
    setError(null);
    setEditions(emptyList);
    void api.releases(work).then(read => {
      if (ticket !== generation.current) return;
      setLoading(false);
      if (!read.ok) { setError(t.loadFailed); return; }
      setEditions(reduceRecordPage(emptyList, read));
      setRelease(current => current || (read.data.complete && read.data.items.length === 1 ? read.data.items[0]!.id : ''));
    });
    return () => { generation.current += 1; };
  }, [open, work, api, t.loadFailed]);

  async function moreEditions() {
    const cursor = editions.nextCursor;
    if (!cursor || moreBusy) return;
    const ticket = generation.current;
    const held = editions;
    setMoreBusy(true);
    const read = await api.releases(work, cursor);
    if (ticket !== generation.current) return;
    setEditions(reduceRecordPage(held, read));
    setMoreBusy(false);
  }

  async function save() {
    setError(null);
    if (!release) { setError(t.editionRequired); return; }
    setSaving(true);
    const acquiredFrom = await chosenParty(api, mode, name, handle, false, t, setError);
    if (acquiredFrom === 'invalid') { setSaving(false); return; }
    const draft = { release, format: format.trim() || null, acquiredFrom, acquiredAt: dayInstant(acquiredOn),
      ownedFrom: dayInstant(ownedSince) };
    const written = await recordOwnedCopy(api, command.current, work, draft);
    setSaving(false);
    if (!written.ok) { setError(failureText(written.failure, t, true)); return; }
    onSaved(written.data);
    onOpenChange(false);
  }

  return <Dialog open={open} onOpenChange={details => onOpenChange(details.open)} pending={saving}>
    <DialogContent size="sm">
      <form noValidate onSubmit={event => { event.preventDefault(); void save(); }} className="contents">
        <DialogHeader title={t.ownCopyTitle({ title })} description={t.ownCopyHelp} />
        <DialogBody className="grid gap-4">
          {loading ? <p className="text-muted-foreground text-sm">{t.loading}</p> : releases.length
            ? <fieldset className="grid min-w-0 gap-2">
              <legend className="font-medium text-sm">{t.edition}</legend>
              <RadioGroup value={release} onValueChange={({ value }) => setRelease(value ?? '')} aria-label={t.edition}>
                {releases.map(item => <RadioGroupItem key={item.id} value={item.id} className="min-w-0">
                  <span className="text-pretty [overflow-wrap:anywhere]">{editionLabel(item)}</span>
                </RadioGroupItem>)}
              </RadioGroup>
              <MoreRecords mode={recordContinuation(editions)} busy={moreBusy} failedText={t.moreRecordsFailed}
                moreLabel={t.showMoreEditions} retryLabel={t.retry} onMore={() => void moreEditions()} />
            </fieldset>
            : error ? null : <p className="text-pretty text-muted-foreground text-sm">{t.noEdition}</p>}
          <Field>
            <FieldLabel>{t.format}</FieldLabel>
            <Input value={format} maxLength={100} autoComplete="off" placeholder={t.formatPlaceholder}
              onChange={event => setFormat(event.currentTarget.value)} />
          </Field>
          <PartyFields legend={t.acquiredFrom} mode={mode} name={name} handle={handle} t={t} onMode={setMode}
            onName={setName} onHandle={setHandle} />
          <Field>
            <FieldLabel>{t.acquiredOn}</FieldLabel>
            <Input type="date" value={acquiredOn} onChange={event => setAcquiredOn(event.currentTarget.value)} />
          </Field>
          <Field>
            <FieldLabel>{t.ownedSince}</FieldLabel>
            <Input type="date" value={ownedSince} onChange={event => setOwnedSince(event.currentTarget.value)} />
          </Field>
          {error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="outline">{t.cancel}</Button></DialogClose>
          <Button type="submit" aria-busy={saving || undefined} disabled={saving || loading || !releases.length}>
            {t.saveCopy}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function LendDialog({ work, title, open, onOpenChange, locale, messages, onSaved }: {
  work: string; title: string; open: boolean; onOpenChange: (open: boolean) => void; locale: UiLocale;
  messages: LibraryMessages; onSaved: (loan: LoanRecord) => void;
}) {
  const t = materializeData(messages, { locale });
  const api = useCopiesApi();
  const [owned, setOwned] = useState<RecordList<CopyRecord>>(emptyList);
  const [editions, setEditions] = useState<RecordList<ReleaseChoice>>(emptyList);
  const [copy, setCopy] = useState('');
  const [direction, setDirection] = useState<'lent' | 'borrowed'>('lent');
  const [mode, setMode] = useState<PartyMode>('name');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [started, setStarted] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const copies = owned.items;
  const releases = editions.items;

  useEffect(() => {
    if (!open) return;
    const ticket = ++generation.current;
    setLoading(true);
    setMoreBusy(false);
    setError(null);
    setOwned(emptyList);
    setEditions(emptyList);
    setStarted(localInput(Date.now() - 3_600_000));
    setDue(laterDay(today(Date.now()), 14));
    void Promise.all([api.copies(work), api.releases(work)]).then(async ([ownedPage, editionPage]) => {
      if (ticket !== generation.current) return;
      if (!ownedPage.ok || !editionPage.ok) { setLoading(false); setError(t.loadFailed); return; }
      const listed = reduceRecordPage(emptyList, ownedPage);
      const labeled = await fillEditions(api, work, reduceRecordPage(emptyList, editionPage),
        new Set(listed.items.map(item => item.release)));
      if (ticket !== generation.current) return;
      setLoading(false);
      setOwned(listed);
      setEditions(labeled);
      setCopy(current => current || (ownedPage.data.complete && ownedPage.data.items.length === 1
        ? ownedPage.data.items[0]!.id : ''));
    });
    return () => { generation.current += 1; };
  }, [open, work, api, t.loadFailed]);

  async function moreCopies() {
    const cursor = owned.nextCursor;
    if (!cursor || moreBusy) return;
    const ticket = generation.current;
    const held = owned;
    const heldEditions = editions;
    setMoreBusy(true);
    const read = await api.copies(work, cursor);
    if (ticket !== generation.current) return;
    const listed = reduceRecordPage(held, read);
    const labeled = await fillEditions(api, work, heldEditions, new Set(listed.items.map(item => item.release)));
    if (ticket !== generation.current) return;
    setOwned(listed);
    setEditions(labeled);
    setMoreBusy(false);
  }

  async function save() {
    setError(null);
    if (!copy && (copies.length !== 1 || owned.nextCursor)) { setError(t.copyRequired); return; }
    const chosenCopy = copy || copies[0]!.id;
    const startedAt = instantFromLocal(started);
    const dueAt = dueInstant(due);
    if (!startedAt || Date.parse(startedAt) > Date.now()) { setError(t.startInFuture); return; }
    if (!dueAt || dueAt < startedAt) { setError(t.dueBeforeStart); return; }
    setSaving(true);
    const counterparty = await chosenParty(api, mode, name, handle, true, t, setError);
    if (counterparty === 'invalid' || !counterparty) { setSaving(false); return; }
    const draft = { copy: chosenCopy, direction, counterparty, startedAt, dueAt };
    const written = await submitRecord(`loan:${chosenCopy}`, draft, (choice, round) => writeNewest(round, 0,
      () => api.openLoan(choice, round.key),
      async () => {
        const loans = await api.loans({ state: 'active' });
        if (!loans.ok) return loans;
        return { ok: true, data: loans.data.items.find(loan => openedLoanMatches(loan, choice)) ?? null };
      },
      current => openedLoanMatches(current, choice),
      current => current.version, false));
    setSaving(false);
    if (!written.ok) { setError(failureText(written.failure, t, false)); return; }
    onSaved(written.data);
    onOpenChange(false);
  }

  const label = (item: CopyRecord) => {
    const edition = releases.find(release => release.id === item.release);
    return [item.format, edition ? editionLabel(edition) : null].filter(Boolean).join(' — ') || t.recordedCopy;
  };

  return <Dialog open={open} onOpenChange={details => onOpenChange(details.open)} pending={saving}>
    <DialogContent size="sm">
      <form noValidate onSubmit={event => { event.preventDefault(); void save(); }} className="contents">
        <DialogHeader title={t.lendTitle({ title })} description={t.lendHelp} />
        <DialogBody className="grid gap-4">
          {loading ? <p className="text-muted-foreground text-sm">{t.loading}</p> : copies.length
            ? <fieldset className="grid min-w-0 gap-2">
              <legend className="font-medium text-sm">{t.whichCopy}</legend>
              <RadioGroup value={copy} onValueChange={({ value }) => setCopy(value ?? '')} aria-label={t.whichCopy}>
                {copies.map(item => <RadioGroupItem key={item.id} value={item.id} className="min-w-0">
                  <span className="text-pretty [overflow-wrap:anywhere]">{label(item)}</span>
                </RadioGroupItem>)}
              </RadioGroup>
              <MoreRecords mode={recordContinuation(owned)} busy={moreBusy} failedText={t.moreRecordsFailed}
                moreLabel={t.showMoreCopies} retryLabel={t.retry} onMore={() => void moreCopies()} />
            </fieldset>
            : <p className="text-pretty text-muted-foreground text-sm">{t.noCopyYet}</p>}
          <fieldset className="grid gap-2">
            <legend className="font-medium text-sm">{t.loanDirection}</legend>
            <RadioGroup value={direction} onValueChange={({ value }) => {
              if (value === 'lent' || value === 'borrowed') setDirection(value);
            }} aria-label={t.loanDirection}>
              <RadioGroupItem value="lent">{t.lending}</RadioGroupItem>
              <RadioGroupItem value="borrowed">{t.borrowing}</RadioGroupItem>
            </RadioGroup>
          </fieldset>
          <PartyFields legend={t.who} mode={mode} name={name} handle={handle} t={t} onMode={setMode} onName={setName}
            onHandle={setHandle} />
          <Field>
            <FieldLabel>{t.startedAt}</FieldLabel>
            <Input type="datetime-local" value={started} onChange={event => setStarted(event.currentTarget.value)} />
          </Field>
          <Field>
            <FieldLabel>{t.dueAt}</FieldLabel>
            <Input type="date" value={due} onChange={event => setDue(event.currentTarget.value)} />
          </Field>
          {error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="outline">{t.cancel}</Button></DialogClose>
          <Button type="submit" aria-busy={saving || undefined} disabled={saving || loading || !copies.length}>
            {t.saveLoan}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ExtendDialog({ loan, open, onOpenChange, locale, messages, onSaved }: {
  loan: LoanRecord; open: boolean; onOpenChange: (open: boolean) => void; locale: UiLocale;
  messages: LibraryMessages; onSaved: (loan: LoanRecord) => void;
}) {
  const t = materializeData(messages, { locale });
  const api = useCopiesApi();
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const day = dueDay(loan.dueAt);
    setDue(day ? laterDay(day, 14) : '');
  }, [open, loan.dueAt]);

  async function save() {
    const dueAt = dueInstant(due);
    const current = dueDay(loan.dueAt);
    if (!dueAt || !current || due <= current || dueAt <= loan.dueAt) { setError(t.extendForward); return; }
    setSaving(true);
    const written: RecordResult<LoanRecord> = await submitRecord(loan.id, dueAt, (choice, round) => writeNewest(round,
      loan.version, version => api.extendLoan(loan.id, version, choice, round.key), () => api.findLoan(loan.id),
      current => extendedLoanMatches(current, choice), current => current.version));
    setSaving(false);
    if (!written.ok) { setError(failureText(written.failure, t, false)); return; }
    onSaved(written.data);
    onOpenChange(false);
  }

  return <Dialog open={open} onOpenChange={details => onOpenChange(details.open)} pending={saving}>
    <DialogContent size="sm">
      <form noValidate onSubmit={event => { event.preventDefault(); void save(); }} className="contents">
        <DialogHeader title={t.extendTitle} description={t.extendHelp} />
        <DialogBody className="grid gap-4">
          <p className="text-muted-foreground text-sm">{t.currentDue({ date: formatDay(loan.dueAt, locale) })}</p>
          <Field invalid={error !== null}>
            <FieldLabel>{t.newDue}</FieldLabel>
            <Input type="date" value={due} onChange={event => { setDue(event.currentTarget.value); setError(null); }} />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="outline">{t.cancel}</Button></DialogClose>
          <Button type="submit" aria-busy={saving || undefined} disabled={saving}>{t.extendLoan}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ReturnDialog({ loan, open, onOpenChange, locale, messages, onSaved }: {
  loan: LoanRecord; open: boolean; onOpenChange: (open: boolean) => void; locale: UiLocale;
  messages: LibraryMessages; onSaved: (loan: LoanRecord) => void;
}) {
  const t = materializeData(messages, { locale });
  const api = useCopiesApi();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const written = await submitRecord(loan.id, loan.version, (version, round) => writeNewest(round, version,
      expected => api.returnLoan(loan.id, expected, round.key), () => api.findLoan(loan.id),
      current => returnedLoanMatches(current), current => current.version));
    setSaving(false);
    if (!written.ok) { setError(failureText(written.failure, t, false)); return; }
    onSaved(written.data);
    onOpenChange(false);
  }

  return <AlertDialog open={open} onOpenChange={details => { onOpenChange(details.open); setError(null); }} pending={saving}>
    <AlertDialogContent size="sm">
      <AlertDialogHeader title={t.returnTitle} description={t.returnBody} />
      {error ? <p role="alert" className="px-6 text-destructive-foreground text-sm">{error}</p> : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={saving}>{t.cancel}</AlertDialogCancel>
        <Button aria-busy={saving || undefined} disabled={saving} onClick={() => void save()}>{t.confirmReturn}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
