'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Textarea } from '@rezics/ui/textarea';
import { CheckIcon, CircleAlertIcon, ClockIcon, CopyIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { Notice } from '../discover/notice.tsx';
import { type Failure, readCase, writeCase } from './report-api.ts';
import { type CaseStatus, type CaseStep, type CounterNotice, credentialFromHash, fill, keyed, textFor, type Text,
  waitText } from './report.ts';

const MAX_PAGES = 20;

/** What the page knows: reading the address, a case, or why there is none. */
export type CaseState =
  | { kind: 'reading' }
  | { kind: 'no-key' }
  | { kind: 'loaded'; status: CaseStatus }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

const stamp = (value: string, locale: UiLocale) => new Intl.DateTimeFormat(locale,
  { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/** One thing that happened: its kind, when, and any words that came with it in their own language. */
function Step({ step, t, locale }: { step: CaseStep; t: Text; locale: UiLocale }) {
  return <li className="grid gap-1 border-border/60 border-s-2 ps-4">
    <p className="font-medium">{keyed(t, 'step', step.kind, step.kind)}</p>
    <p className="text-muted-foreground text-sm">
      <time dateTime={step.occurredAt}>{stamp(step.occurredAt, locale)}</time>
      {step.dueAt ? <> · <ClockIcon aria-hidden="true" className="inline size-3.5 align-text-bottom" />{' '}
        <time dateTime={step.dueAt}>{fill(t.dueBy, { time: stamp(step.dueAt, locale) })}</time></> : null}
    </p>
    {step.statement ? <p lang={step.contentLanguage ?? undefined} className="whitespace-pre-line text-pretty
      [overflow-wrap:anywhere]">{step.statement}</p> : null}
  </li>;
}

/** Why a send did not go through, in the words the form can act on. */
const sendProblem = (failure: Failure, t: Text, locale: UiLocale, refused: string) =>
  failure.reason === 'limited' ? fill(t.retryIn, { time: waitText(failure.retryAfter, locale) })
    : failure.reason === 'invalid' ? refused : failure.reason === 'denied' ? t.counterOnlyAffected : t.sendFailed;

/**
 * A form that writes to the case. The key is kept until the words change, so a
 * lost response and a second press file one entry.
 */
function Correspondence({ heading, help, children, submitLabel, locale, caseId, credential, kind, build, onSent, valid,
  refused, confirm, send }: {
  heading: string; help: string; children: (controls: { statement: string; setStatement: (value: string) => void }) => ReactNode;
  submitLabel: string; locale: UiLocale; caseId: string; credential: string; kind: 'message' | 'appeal' | 'counter_notice';
  build: (statement: string) => { counterNotice?: CounterNotice } | null; onSent: () => void;
  valid: (statement: string) => string | null; refused: string; confirm?: ReactNode; send?: typeof fetch;
}) {
  const t = textFor(locale);
  const [statement, setStatement] = useState('');
  const [language, setLanguage] = useState<string>(locale);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problem = valid(statement);
    const extra = build(statement);
    if (problem || !extra) { setError(problem ?? t.declarationsRequired); return; }
    const body = { kind, statement: statement.trim(), contentLanguage: language, ...extra };
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true); setError(null); setSent(false);
    const result = await writeCase({ locale, caseId, credential, key: attempt.current.key, body }, send);
    setBusy(false);
    if (!result.ok) { setError(sendProblem(result, t, locale, refused)); return; }
    setStatement(''); attempt.current = null; setSent(true);
    onSent();
  }
  return <section className="grid max-w-2xl gap-3 rounded-2xl border border-border/60 p-4 sm:p-5">
    <h2 className="font-semibold">{heading}</h2>
    <p className="text-muted-foreground text-sm">{help}</p>
    {confirm}
    <form noValidate onSubmit={event => void submit(event)} className="grid gap-4" aria-label={heading}>
      {children({ statement, setStatement })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t.languageLabel}</span>
        <LanguageSelect value={language} onChange={setLanguage} locale={locale} label={t.languageLabel} />
      </div>
      {error ? <Alert variant="destructive" role="alert"><CircleAlertIcon aria-hidden="true" />
        <AlertDescription>{error}</AlertDescription></Alert> : null}
      {sent ? <p role="status" className="flex items-center gap-2 text-sm text-success-foreground">
        <CheckIcon aria-hidden="true" className="size-4" />{t.sent}</p> : null}
      <div><Button type="submit" isLoading={busy} disabled={busy}>{submitLabel}</Button></div>
    </form>
  </section>;
}

const blankCounter = { signature: '', materialLocation: '', name: '', address: '', phone: '', courtJurisdiction: '',
  goodFaith: false, consent: false, service: false };

function Line({ label, value, onChange, help, maxLength, type = 'text' }: { label: string; value: string;
  onChange: (value: string) => void; help?: string; maxLength: number; type?: 'text' | 'tel' }) {
  return <Field><FieldLabel>{label}</FieldLabel>
    <Input type={type} value={value} maxLength={maxLength} onChange={event => onChange(event.currentTarget.value)} />
    {help ? <FieldHelper>{help}</FieldHelper> : null}</Field>;
}

/** The DMCA counter-notice: its declarations, and the warning that the sender's details are disclosed. */
function CounterNoticeForm(props: { locale: UiLocale; caseId: string; credential: string; onSent: () => void;
  send?: typeof fetch }) {
  const t = textFor(props.locale);
  const [counter, setCounter] = useState(blankCounter);
  const complete = Object.entries(counter).every(([, value]) => typeof value === 'boolean' ? value : value.trim());
  return <Correspondence {...props} kind="counter_notice" heading={t.counterHeading} help={t.counterHelp}
    submitLabel={t.sendCounter} refused={t.sendRefused}
    confirm={<Alert variant="warning" role="note"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription>{t.counterDisclosure}</AlertDescription></Alert>}
    valid={statement => statement.trim() ? null : t.messageRequired}
    build={() => complete ? { counterNotice: { signature: counter.signature.trim(),
      materialLocation: counter.materialLocation.trim(), goodFaithMistakeUnderPerjury: true as const,
      name: counter.name.trim(), address: counter.address.trim(), phone: counter.phone.trim(),
      courtJurisdiction: counter.courtJurisdiction.trim(), consentToJurisdiction: true as const,
      acceptService: true as const } } : null}>
    {({ statement, setStatement }) => <>
      <Field><FieldLabel>{t.counterStatement}</FieldLabel>
        <Textarea value={statement} rows={3} maxLength={8000} onChange={event => setStatement(event.currentTarget.value)} /></Field>
      <Line label={t.counterLocation} value={counter.materialLocation} maxLength={1000}
        onChange={materialLocation => setCounter({ ...counter, materialLocation })} />
      <Line label={t.counterName} value={counter.name} maxLength={300} onChange={name => setCounter({ ...counter, name })} />
      <Line label={t.counterAddress} value={counter.address} maxLength={500}
        onChange={address => setCounter({ ...counter, address })} />
      <Line label={t.counterPhone} type="tel" value={counter.phone} maxLength={100}
        onChange={phone => setCounter({ ...counter, phone })} />
      <Line label={t.counterCourt} help={t.counterCourtHelp} value={counter.courtJurisdiction} maxLength={1000}
        onChange={courtJurisdiction => setCounter({ ...counter, courtJurisdiction })} />
      {([['goodFaith', t.counterMistake], ['consent', t.counterConsent], ['service', t.counterService]] as const)
        .map(([key, label]) => <Field key={key} orientation="horizontal">
          <Checkbox checked={counter[key]} onCheckedChange={details => setCounter({ ...counter, [key]: details.checked === true })} />
          <FieldContent><FieldLabel>{label}</FieldLabel></FieldContent></Field>)}
      <Line label={t.counterSignature} value={counter.signature} maxLength={300}
        onChange={signature => setCounter({ ...counter, signature })} />
    </>}
  </Correspondence>;
}

/** The report page: reads the credential from the address and shows the case it opens. */
export function CaseView({ locale, caseId, initial, credential: given, send }: {
  locale: UiLocale; caseId: string;
  /** Stories and tests start from a known state, and a known credential, instead of reading the address. */
  initial?: CaseState; credential?: string; send?: typeof fetch;
}) {
  const t = textFor(locale);
  const [state, setState] = useState<CaseState>(initial ?? { kind: 'reading' });
  const [credential, setCredential] = useState<string | null>(null);
  const [steps, setSteps] = useState<CaseStep[]>(initial?.kind === 'loaded' ? initial.status.steps : []);
  const [cursor, setCursor] = useState<string | null>(initial?.kind === 'loaded' ? initial.status.nextCursor : null);
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (secret: string, all: boolean) => {
    let after: string | null = null;
    const collected: CaseStep[] = [];
    for (let page = 0; page < (all ? MAX_PAGES : 1); page += 1) {
      const result = await readCase({ locale, caseId, credential: secret, cursor: after }, send);
      if (!result.ok) { setState({ kind: result.reason === 'denied' ? 'unavailable' : 'failed' }); return; }
      collected.push(...result.data.steps);
      setState({ kind: 'loaded', status: result.data });
      after = result.data.nextCursor;
      if (!after) break;
    }
    setSteps(collected);
    setCursor(after);
  }, [locale, caseId, send]);

  useEffect(() => {
    if (initial) { setCredential(given ?? credentialFromHash(location.hash)); return; }
    const secret = given ?? credentialFromHash(location.hash);
    setCredential(secret);
    if (!secret) { setState({ kind: 'no-key' }); return; }
    void load(secret, false);
  }, [initial, given, load]);

  if (state.kind === 'reading') return <p role="status" className="text-muted-foreground">{t.loading}</p>;
  if (state.kind === 'no-key') return <Notice icon={KeyRoundIcon} headingLevel={2} title={t.keyMissingTitle}
    description={t.keyMissingBody} />;
  if (state.kind === 'unavailable') return <Notice icon={KeyRoundIcon} headingLevel={2} tone="destructive"
    title={t.unavailableTitle} description={t.unavailableBody} />;
  if (state.kind === 'failed') return <Notice icon={TriangleAlertIcon} headingLevel={2} tone="destructive"
    title={t.loadFailedTitle} description={t.loadFailedBody}>
    <Button variant="outline" size="sm" onClick={() => credential && void load(credential, false)}>{t.retry}</Button>
  </Notice>;

  const { status } = state;
  const decided = status.outcome !== null;
  const showMore = async () => {
    if (!credential || !cursor) return;
    setMore(true);
    const result = await readCase({ locale, caseId, credential, cursor }, send);
    setMore(false);
    if (!result.ok) { setState({ kind: 'failed' }); return; }
    setSteps(current => [...current, ...result.data.steps]);
    setCursor(result.data.nextCursor);
  };
  const copy = () => void navigator.clipboard.writeText(location.href).then(() => setCopied(true), () => setCopied(false));
  const sent = () => { if (credential) void load(credential, true); };
  return <div className="grid gap-8">
    <div className="grid max-w-2xl gap-3">
      <p className="text-muted-foreground text-sm">{t.statusIntro}</p>
      <p className="flex flex-wrap items-center gap-3 text-sm"><span>{t.statusKeep}</span>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? t.addressCopied : t.copyAddress}</Button>
        {copied ? <span role="status" className="sr-only">{t.addressCopied}</span> : null}</p>
    </div>

    <dl className="grid max-w-2xl gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
      <dt className="text-muted-foreground text-sm">{t.received}</dt>
      <dd><time dateTime={status.receivedAt}>{stamp(status.receivedAt, locale)}</time></dd>
      <dt className="text-muted-foreground text-sm">{t.kind}</dt>
      <dd>{keyed(t, 'cat', status.category, status.category)}</dd>
      <dt className="text-muted-foreground text-sm">{t.state}</dt>
      <dd>{keyed(t, 'state', status.state, status.state)}</dd>
      <dt className="text-muted-foreground text-sm">{t.outcome}</dt>
      <dd>{decided ? keyed(t, 'outcome', status.outcome!, status.outcome!) : t.noOutcome}</dd>
      {status.reasons ? <><dt className="text-muted-foreground text-sm">{t.reasons}</dt>
        <dd className="whitespace-pre-line text-pretty [overflow-wrap:anywhere]">{status.reasons}</dd></> : null}
    </dl>
    {status.category === 'ncii' ? <p role="note" className="max-w-2xl rounded-2xl bg-muted/60 p-4 text-sm font-medium">
      {t.nciiNotice}</p> : null}

    <section aria-labelledby="case-history" className="grid max-w-2xl gap-3">
      <h2 id="case-history" className="font-semibold">{t.historyHeading}</h2>
      <ol className="grid gap-4">{steps.map(step => <Step key={step.id} step={step} t={t} locale={locale} />)}</ol>
      {cursor ? <div><Button type="button" variant="outline" size="sm" onClick={() => void showMore()}
        isLoading={more} disabled={more}>{t.loadMore}</Button></div> : null}
    </section>

    {credential ? <>
      <Correspondence heading={t.followUpHeading} help={t.followUpHelp} submitLabel={t.sendMessage} locale={locale}
        caseId={caseId} credential={credential} kind="message" build={() => ({})} onSent={sent} send={send}
        refused={t.sendRefused} valid={statement => statement.trim() ? null : t.messageRequired}>
        {({ statement, setStatement }) => <Field><FieldLabel>{t.messageLabel}</FieldLabel>
          <Textarea value={statement} rows={4} maxLength={8000} onChange={event => setStatement(event.currentTarget.value)} />
        </Field>}
      </Correspondence>
      {decided ? <Correspondence heading={t.appealHeading} help={t.appealHelp} submitLabel={t.sendAppeal}
        locale={locale} caseId={caseId} credential={credential} kind="appeal" build={() => ({})} onSent={sent} send={send}
        refused={t.sendRefused} valid={statement => statement.trim() ? null : t.messageRequired}>
        {({ statement, setStatement }) => <Field><FieldLabel>{t.appealLabel}</FieldLabel>
          <Textarea value={statement} rows={4} maxLength={8000} onChange={event => setStatement(event.currentTarget.value)} />
        </Field>}
      </Correspondence> : null}
      {decided && status.process === 'dmca_512' ? <CounterNoticeForm locale={locale} caseId={caseId}
        credential={credential} onSent={sent} send={send} /> : null}
    </> : null}
  </div>;
}
