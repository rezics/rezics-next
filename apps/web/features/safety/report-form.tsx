'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { CircleAlertIcon, ShieldAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { type Failure, submitReport } from './report-api.ts';
import { casePath, type CopyrightDeclaration, categoriesFor, declarationOf, fill, isUrgent, keyed, needsEmail,
  type NciiDeclaration, plausibleTarget, type ReportCategory, textFor, waitText } from './report.ts';

type Problem = 'target' | 'category' | 'statement' | 'email' | 'declarations';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const blankNcii = { signature: '', authorized: false, goodFaith: false, supportingInformation: '' };
const blankCopyright = { signature: '', claimantName: '', claimantAddress: '', claimantPhone: '', claimedWork: '',
  materialLocation: '', goodFaith: false, perjury: false };

function Statement({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void;
  children: string }) {
  return <Field orientation="horizontal">
    <Checkbox checked={checked} onCheckedChange={details => onChange(details.checked === true)} />
    <FieldContent><FieldLabel>{children}</FieldLabel></FieldContent>
  </Field>;
}

function Line({ label, value, onChange, help, multiline = false, type = 'text', invalid = false, maxLength }: {
  label: string; value: string; onChange: (value: string) => void; help?: string; multiline?: boolean;
  type?: 'text' | 'email' | 'tel'; invalid?: boolean; maxLength?: number;
}) {
  return <Field invalid={invalid}>
    <FieldLabel>{label}</FieldLabel>
    {multiline ? <Textarea value={value} rows={3} maxLength={maxLength} onChange={event => onChange(event.currentTarget.value)} />
      : <Input type={type} value={value} maxLength={maxLength} onChange={event => onChange(event.currentTarget.value)} />}
    {help ? <FieldHelper>{help}</FieldHelper> : null}
  </Field>;
}

/**
 * The public report form, for anyone: no account, no CAPTCHA, no image field.
 * A person chooses a kind of problem and sees only that kind's own form. What
 * a kind needs is what Main requires of it; Main decides what is valid.
 * Retrying after a lost response sends the same Idempotency-Key, so it files
 * one case, and a changed report gets a new key.
 */
export function ReportForm({ locale, target: initialTarget = '', realm = null, send }: {
  locale: UiLocale; target?: string; realm?: string | null; send?: typeof fetch;
}) {
  const t = textFor(locale);
  const router = useRouter();
  const [target, setTarget] = useState(initialTarget);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [statement, setStatement] = useState('');
  const [language, setLanguage] = useState<string>(locale);
  const [email, setEmail] = useState('');
  const [ncii, setNcii] = useState(blankNcii);
  const [copyright, setCopyright] = useState(blankCopyright);
  const [problems, setProblems] = useState<ReadonlySet<Problem>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  // Until the page is interactive a native submit would put the report in the address; the button waits.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const declaration = category ? declarationOf(category) : null;
  const emailRequired = category ? needsEmail(category) : false;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const found = new Set<Problem>();
    if (!plausibleTarget(target)) found.add('target');
    if (!category) found.add('category');
    if (!statement.trim()) found.add('statement');
    if (email.trim() ? !EMAIL.test(email.trim()) : emailRequired) found.add('email');
    if (declaration === 'ncii' && (!ncii.signature.trim() || !ncii.authorized || !ncii.goodFaith
      || !ncii.supportingInformation.trim())) found.add('declarations');
    if (declaration === 'copyright' && (!copyright.goodFaith || !copyright.perjury || Object.entries(copyright)
      .some(([, value]) => typeof value === 'string' && !value.trim()))) found.add('declarations');
    setProblems(found);
    if (found.size || !category) return;
    const body = {
      target: target.trim(), category, statement: statement.trim(), contentLanguage: language,
      ...(email.trim() ? { contactEmail: email.trim() } : {}),
      ...(category === 'realm_rules' && realm ? { realm } : {}),
      ...(declaration === 'ncii' ? { ncii: { signature: ncii.signature.trim(), depictedPersonOrAuthorized: true as const,
        goodFaithWithoutConsent: true as const, supportingInformation: ncii.supportingInformation.trim() } satisfies NciiDeclaration } : {}),
      ...(declaration === 'copyright' ? { copyright: { signature: copyright.signature.trim(),
        claimantName: copyright.claimantName.trim(), claimantAddress: copyright.claimantAddress.trim(),
        claimantPhone: copyright.claimantPhone.trim(), claimedWork: copyright.claimedWork.trim(),
        materialLocation: copyright.materialLocation.trim(), goodFaith: true as const,
        accurateAndAuthorizedUnderPerjury: true as const } satisfies CopyrightDeclaration } : {}),
    };
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true);
    setFailure(null);
    const result = await submitReport(body, attempt.current.key, send);
    setBusy(false);
    if (!result.ok) { setFailure(result); return; }
    router.push(localizedPath(casePath(result.data.caseId, result.data.credential), locale));
  }

  const categories = categoriesFor(realm);
  return <form noValidate onSubmit={event => void submit(event)} className="grid max-w-2xl gap-6"
    aria-label={t.title}>
    <Field invalid={problems.has('target')}>
      <FieldLabel>{t.targetLabel}</FieldLabel>
      <Input value={target} inputMode="url" autoComplete="off" onChange={event => setTarget(event.currentTarget.value)} />
      {problems.has('target') ? <FieldError>{t.targetInvalid}</FieldError> : <FieldHelper>{t.targetHelp}</FieldHelper>}
    </Field>

    <div className="grid gap-2">
      <RadioGroup value={category ?? ''} onValueChange={details => setCategory((details.value || null) as ReportCategory | null)}
        className="gap-2">
        <RadioGroupLabel>{t.categoryLabel}</RadioGroupLabel>
        {categories.map(item => <RadioGroupItem key={item} value={item}>
          <span className="grid gap-0.5">
            <span className="font-medium">{keyed(t, 'cat', item)}</span>
            <span className="text-muted-foreground text-sm">{keyed(t, 'hint', item)}{isUrgent(item) ? ` ${t.urgent}` : ''}</span>
          </span>
        </RadioGroupItem>)}
      </RadioGroup>
      {problems.has('category') ? <p role="alert" className="text-destructive-foreground text-sm">{t.categoryRequired}</p> : null}
    </div>

    {declaration === 'ncii' ? <section aria-labelledby="ncii-heading" className="grid gap-4 rounded-2xl bg-muted/60 p-4">
      <h2 id="ncii-heading" className="flex items-center gap-2 font-semibold">
        <ShieldAlertIcon aria-hidden="true" className="size-4" />{t.nciiHeading}</h2>
      <p className="text-sm">{t.nciiNoImage}</p>
      <p role="note" className="text-sm font-medium">{t.nciiNotice}</p>
      <Statement checked={ncii.authorized} onChange={authorized => setNcii({ ...ncii, authorized })}>
        {t.nciiAuthorized}</Statement>
      <Statement checked={ncii.goodFaith} onChange={goodFaith => setNcii({ ...ncii, goodFaith })}>
        {t.nciiGoodFaith}</Statement>
      <Line label={t.nciiSupporting} help={t.nciiSupportingHelp} multiline maxLength={4000}
        value={ncii.supportingInformation}
        onChange={supportingInformation => setNcii({ ...ncii, supportingInformation })} />
      <Line label={t.nciiSignature} value={ncii.signature} maxLength={300}
        onChange={signature => setNcii({ ...ncii, signature })} />
      {problems.has('declarations') ? <p role="alert" className="text-destructive-foreground text-sm">
        {t.declarationsRequired}</p> : null}
    </section> : null}

    {declaration === 'copyright' ? <section aria-labelledby="copyright-heading"
      className="grid gap-4 rounded-2xl bg-muted/60 p-4">
      <h2 id="copyright-heading" className="font-semibold">{t.copyrightHeading}</h2>
      <p role="note" className="text-sm font-medium">{t.copyrightNotice}</p>
      <Line label={t.claimantName} value={copyright.claimantName} maxLength={300}
        onChange={claimantName => setCopyright({ ...copyright, claimantName })} />
      <Line label={t.claimantAddress} value={copyright.claimantAddress} maxLength={500}
        onChange={claimantAddress => setCopyright({ ...copyright, claimantAddress })} />
      <Line label={t.claimantPhone} type="tel" value={copyright.claimantPhone} maxLength={100}
        onChange={claimantPhone => setCopyright({ ...copyright, claimantPhone })} />
      <Line label={t.claimedWork} multiline value={copyright.claimedWork} maxLength={1000}
        onChange={claimedWork => setCopyright({ ...copyright, claimedWork })} />
      <Line label={t.materialLocation} multiline value={copyright.materialLocation} maxLength={1000}
        onChange={materialLocation => setCopyright({ ...copyright, materialLocation })} />
      <Statement checked={copyright.goodFaith} onChange={goodFaith => setCopyright({ ...copyright, goodFaith })}>
        {t.copyrightGoodFaith}</Statement>
      <Statement checked={copyright.perjury} onChange={perjury => setCopyright({ ...copyright, perjury })}>
        {t.copyrightPerjury}</Statement>
      <Line label={t.copyrightSignature} value={copyright.signature} maxLength={300}
        onChange={signature => setCopyright({ ...copyright, signature })} />
      {problems.has('declarations') ? <p role="alert" className="text-destructive-foreground text-sm">
        {t.declarationsRequired}</p> : null}
    </section> : null}

    <Field invalid={problems.has('statement')}>
      <FieldLabel>{t.statementLabel}</FieldLabel>
      <Textarea value={statement} rows={5} maxLength={4000} onChange={event => setStatement(event.currentTarget.value)} />
      {problems.has('statement') ? <FieldError>{t.statementRequired}</FieldError>
        : <FieldHelper>{t.statementHelp}</FieldHelper>}
    </Field>

    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{t.languageLabel}</span>
      <LanguageSelect value={language} onChange={setLanguage} locale={locale} label={t.languageLabel} />
    </div>

    <Field invalid={problems.has('email')}>
      <FieldLabel>{t.emailLabel}</FieldLabel>
      <Input type="email" value={email} autoComplete="email" maxLength={320}
        onChange={event => setEmail(event.currentTarget.value)} />
      {problems.has('email') ? <FieldError>{email.trim() ? t.emailInvalid : t.emailRequiredHelp}</FieldError>
        : <FieldHelper>{emailRequired ? t.emailRequiredHelp : t.emailHelp}</FieldHelper>}
    </Field>

    <p className="text-muted-foreground text-sm">{t.privateNote}</p>
    {failure ? <Alert variant="destructive" role="alert"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{failure.reason === 'limited' ? fill(t.retryIn, { time: waitText(failure.retryAfter, locale) })
        : failure.reason === 'invalid' ? t.refused : failure.reason === 'denied' ? t.targetUnknown : t.failed}
      </AlertDescription></Alert> : null}
    <div><Button type="submit" isLoading={busy} disabled={busy || !hydrated}>{busy ? t.sending : t.submit}</Button></div>
  </form>;
}
