'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CheckIcon, CircleAlertIcon, ClockIcon, CopyIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import { Notice } from '../discover/notice.tsx';
import { Confirm, Line, useFocusProblem } from './form-parts.tsx';
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

/** The structured statement a decision wrote, as Main returns it; the writer's own words stay in their language. */
function StatementOfReasons({ statement, applying, t }: { statement: NonNullable<CaseStatus['statementOfReasons']>;
  applying: boolean; t: Text }) {
  const lang = statement.contentLanguage === 'und' ? undefined : statement.contentLanguage;
  return <section aria-labelledby="case-reasons" className="grid max-w-2xl gap-3 rounded-2xl border border-border/60 p-4 sm:p-5">
    <h2 id="case-reasons" className="font-semibold">{t.sorHeading}</h2>
    <dl lang={lang} className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
      <dt className="text-muted-foreground text-sm">{t.sorFacts}</dt>
      <dd className="whitespace-pre-line text-pretty [overflow-wrap:anywhere]">{statement.facts}</dd>
      <dt className="text-muted-foreground text-sm">{t.sorScope}</dt>
      <dd className="whitespace-pre-line text-pretty [overflow-wrap:anywhere]">{statement.scope}</dd>
      <dt className="text-muted-foreground text-sm">{t.sorDuration}</dt>
      <dd className="whitespace-pre-line text-pretty [overflow-wrap:anywhere]">{statement.duration}</dd>
    </dl>
    <p className="text-sm">{statement.automation ? t.sorAutomationYes : t.sorAutomationNo}</p>
    <p className="text-sm [overflow-wrap:anywhere]">{fill(t.sorRule, { ref: statement.rule.ref, revision: statement.rule.revision })}</p>
    <p className="text-sm">{t.sorAppeal}</p>
    {applying ? <p role="status" className="text-muted-foreground text-sm">{t.sorApplying}</p> : null}
  </section>;
}

/** Why a send did not go through. A link Main does not know says so; only a counter-notice is about who may send it. */
const sendProblem = (failure: Failure, t: Text, locale: UiLocale, refused: string, kind: string) =>
  failure.reason === 'limited' ? fill(t.retryIn, { time: waitText(failure.retryAfter, locale) })
    : failure.reason === 'invalid' ? refused
      : failure.reason === 'denied' ? kind === 'counter_notice' ? t.counterOnlyAffected : t.unavailableBody
        : t.sendFailed;

/**
 * A form that writes to the case. The key is kept until the words change, so a
 * lost response and a second press file one entry. A missing statement or
 * (`ready` false) declaration is said on its field and focus goes to the first.
 * The language is the writer's to state, never the interface locale.
 */
function Correspondence({ heading, help, children, submitLabel, locale, caseId, credential, kind, build, onSent,
  ready = true, refused, confirm, actingSubject = null, send }: {
  heading: string; help: string;
  children: (controls: { statement: string; setStatement: (value: string) => void; tried: boolean;
    written: { lang: string | undefined; dir: 'ltr' | 'rtl' } }) => ReactNode;
  submitLabel: string; locale: UiLocale; caseId: string; credential: string; kind: 'message' | 'appeal' | 'counter_notice';
  build: () => { counterNotice?: CounterNotice }; onSent: () => void;
  /** Whether the declarations around the statement are complete. */
  ready?: boolean; refused: string; confirm?: ReactNode; actingSubject?: string | null; send?: typeof fetch;
}) {
  const t = textFor(locale);
  const form = useRef<HTMLFormElement>(null);
  const [statement, setStatement] = useState('');
  const reading = useReadingLanguages(actingSubject);
  const [chosen, setChosen] = useState<string | null>(null);
  const language = writingLanguage({ chosen, reading });
  const [attempted, setAttempted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useFocusProblem(form, attempted);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!statement.trim() || !ready) { setAttempted(count => count + 1); return; }
    const body = { kind, statement: statement.trim(), contentLanguage: language, ...build() };
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true); setError(null); setSent(false);
    const result = await writeCase({ locale, caseId, credential, key: attempt.current.key, body }, send);
    setBusy(false);
    if (!result.ok) { setError(sendProblem(result, t, locale, refused, kind)); return; }
    setStatement(''); attempt.current = null; setAttempted(0); setSent(true);
    onSent();
  }
  return <section className="grid max-w-2xl gap-3 rounded-2xl border border-border/60 p-4 sm:p-5">
    <h2 className="font-semibold">{heading}</h2>
    <p className="text-muted-foreground text-sm">{help}</p>
    {confirm}
    <form ref={form} noValidate onSubmit={event => void submit(event)} className="grid gap-4" aria-label={heading}>
      {children({ statement, setStatement, tried: attempted > 0, written: textAttributes(language, statement) })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t.languageLabel}</span>
        <LanguageSelect value={language} onChange={setChosen} locale={locale} reading={reading} label={t.languageLabel} />
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
const counterFields = ['materialLocation', 'name', 'address', 'phone', 'courtJurisdiction', 'signature'] as const;

/** The DMCA counter-notice: its declarations, and the warning that the sender's details are disclosed. */
function CounterNoticeForm(props: { locale: UiLocale; caseId: string; credential: string; onSent: () => void;
  actingSubject?: string | null; send?: typeof fetch }) {
  const t = textFor(props.locale);
  const [counter, setCounter] = useState(blankCounter);
  const ready = counterFields.every(key => counter[key].trim()) && counter.goodFaith && counter.consent && counter.service;
  return <Correspondence {...props} kind="counter_notice" heading={t.counterHeading} help={t.counterHelp}
    submitLabel={t.sendCounter} refused={t.sendRefused} ready={ready}
    confirm={<Alert variant="warning" role="note"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription>{t.counterDisclosure}</AlertDescription></Alert>}
    build={() => ({ counterNotice: { signature: counter.signature.trim(),
      materialLocation: counter.materialLocation.trim(), goodFaithMistakeUnderPerjury: true as const,
      name: counter.name.trim(), address: counter.address.trim(), phone: counter.phone.trim(),
      courtJurisdiction: counter.courtJurisdiction.trim(), consentToJurisdiction: true as const,
      acceptService: true as const } })}>
    {({ statement, setStatement, tried, written }) => {
      const missing = (value: string) => tried && !value.trim() ? t.fieldRequired : null;
      const unticked = (value: boolean) => tried && !value ? t.confirmRequired : null;
      return <>
        <Line label={t.counterStatement} multiline value={statement} onChange={setStatement} maxLength={8000}
          error={missing(statement)} lang={written.lang} dir={written.dir} />
        <Line label={t.counterLocation} value={counter.materialLocation} maxLength={1000}
          error={missing(counter.materialLocation)} onChange={materialLocation => setCounter({ ...counter, materialLocation })} />
        <Line label={t.counterName} value={counter.name} maxLength={300} error={missing(counter.name)}
          onChange={name => setCounter({ ...counter, name })} />
        <Line label={t.counterAddress} value={counter.address} maxLength={500} error={missing(counter.address)}
          onChange={address => setCounter({ ...counter, address })} />
        <Line label={t.counterPhone} type="tel" value={counter.phone} maxLength={100} error={missing(counter.phone)}
          onChange={phone => setCounter({ ...counter, phone })} />
        <Line label={t.counterCourt} help={t.counterCourtHelp} value={counter.courtJurisdiction} maxLength={1000}
          error={missing(counter.courtJurisdiction)}
          onChange={courtJurisdiction => setCounter({ ...counter, courtJurisdiction })} />
        <Confirm checked={counter.goodFaith} error={unticked(counter.goodFaith)}
          onChange={goodFaith => setCounter({ ...counter, goodFaith })}>{t.counterMistake}</Confirm>
        <Confirm checked={counter.consent} error={unticked(counter.consent)}
          onChange={consent => setCounter({ ...counter, consent })}>{t.counterConsent}</Confirm>
        <Confirm checked={counter.service} error={unticked(counter.service)}
          onChange={service => setCounter({ ...counter, service })}>{t.counterService}</Confirm>
        <Line label={t.counterSignature} value={counter.signature} maxLength={300} error={missing(counter.signature)}
          onChange={signature => setCounter({ ...counter, signature })} />
      </>;
    }}
  </Correspondence>;
}

/** The report page: reads the credential from the address and shows the case it opens. */
export function CaseView({ locale, caseId, initial, credential: given, actingSubject = null, send }: {
  locale: UiLocale; caseId: string;
  /** The signed-in Agent, whose saved reading languages start the language choice. */
  actingSubject?: string | null;
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
    {status.statementOfReasons ? <StatementOfReasons statement={status.statementOfReasons} t={t}
      applying={status.operation !== null && status.operation.status !== 'completed'} /> : null}
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
        actingSubject={actingSubject} refused={t.sendRefused}>
        {({ statement, setStatement, tried, written }) => <Line label={t.messageLabel} multiline value={statement}
          onChange={setStatement} maxLength={8000} error={tried && !statement.trim() ? t.messageRequired : null}
          lang={written.lang} dir={written.dir} />}
      </Correspondence>
      {decided ? <Correspondence heading={t.appealHeading} help={t.appealHelp} submitLabel={t.sendAppeal}
        locale={locale} caseId={caseId} credential={credential} kind="appeal" build={() => ({})} onSent={sent}
        send={send} actingSubject={actingSubject} refused={t.sendRefused}>
        {({ statement, setStatement, tried, written }) => <Line label={t.appealLabel} multiline value={statement}
          onChange={setStatement} maxLength={8000} error={tried && !statement.trim() ? t.messageRequired : null}
          lang={written.lang} dir={written.dir} />}
      </Correspondence> : null}
      {decided && status.process === 'dmca_512' ? <CounterNoticeForm locale={locale} caseId={caseId}
        credential={credential} onSent={sent} send={send} actingSubject={actingSubject} /> : null}
    </> : null}
  </div>;
}
