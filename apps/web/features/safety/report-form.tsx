'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldError } from '@rezics/ui/field';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { CircleAlertIcon, ExternalLinkIcon, HeartHandshakeIcon, ShieldAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import { Confirm, Line, useFocusProblem } from './form-parts.tsx';
import { type Failure, submitReport } from './report-api.ts';
import { casePath, type CopyrightDeclaration, categoriesFor, declarationOf, fill, isUrgent, keyed, needsEmail,
  type NciiDeclaration, plausibleTarget, type ReportCategory, textFor, waitText } from './report.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CYBERTIPLINE = 'https://www.ncmec.org/gethelpnow/cybertipline';

const blankNcii = { signature: '', authorized: false, goodFaith: false, supportingInformation: '' };
const blankCopyright = { signature: '', claimantName: '', claimantAddress: '', claimantPhone: '', claimedWork: '',
  materialLocation: '', goodFaith: false, perjury: false };
const nciiFields = ['signature', 'supportingInformation'] as const;
const copyrightFields = ['claimantName', 'claimantAddress', 'claimantPhone', 'claimedWork', 'materialLocation',
  'signature'] as const;

/** What to do first, before the form: never copy the material; when someone may be in danger, call for help. */
function Guidance({ category, t }: { category: ReportCategory | null; t: ReturnType<typeof textFor> }) {
  if (category === 'child_exploitation') {
    return <section aria-labelledby="child-safety-heading" className="grid gap-2 rounded-2xl bg-muted/60 p-4 text-sm">
      <h2 id="child-safety-heading" className="flex items-center gap-2 font-semibold">
        <HeartHandshakeIcon aria-hidden="true" className="size-4" />{t.childSafetyHeading}</h2>
      <p>{t.childSafetyNoCopy}</p>
      <p>{t.dangerChild}</p>
      <p>{t.cybertip}{' '}
        <a href={CYBERTIPLINE} rel="noopener noreferrer" target="_blank"
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline">
          {t.cybertipLink}<ExternalLinkIcon aria-hidden="true" className="size-3.5" /></a></p>
    </section>;
  }
  return category === 'credible_threat'
    ? <p role="note" className="rounded-2xl bg-muted/60 p-4 text-sm font-medium">{t.dangerSomeone}</p> : null;
}

/**
 * The public report form, for anyone: no account, no CAPTCHA, no image field.
 * A person chooses a kind of problem and sees only that kind's own form. What
 * a kind needs is what Main requires of it; Main decides what is valid.
 * Retrying after a lost response sends the same Idempotency-Key, so it files
 * one case, and a changed report gets a new key. The statement's language is
 * the writer's to state: their first reading language, or unspecified, never
 * the interface locale (docs/contracts/content-languages.md, Decision 7).
 */
export function ReportForm({ locale, target: initialTarget = '', realm = null, actingSubject = null, send }: {
  locale: UiLocale; target?: string; realm?: string | null;
  /** The signed-in Agent, whose saved reading languages start the language choice. */
  actingSubject?: string | null; send?: typeof fetch;
}) {
  const t = textFor(locale);
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [target, setTarget] = useState(initialTarget);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [statement, setStatement] = useState('');
  const reading = useReadingLanguages(actingSubject);
  const [chosen, setChosen] = useState<string | null>(null);
  const language = writingLanguage({ chosen, reading });
  const [email, setEmail] = useState('');
  const [ncii, setNcii] = useState(blankNcii);
  const [copyright, setCopyright] = useState(blankCopyright);
  const [attempted, setAttempted] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  // Until the page is interactive a native submit would put the report in the address; the button waits.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  useFocusProblem(form, attempted);
  const declaration = category ? declarationOf(category) : null;
  const emailRequired = category ? needsEmail(category) : false;

  // Each problem is said on its own field, once a submit has been tried.
  const tried = attempted > 0;
  const missing = (value: string) => tried && !value.trim() ? t.fieldRequired : null;
  const unticked = (value: boolean) => tried && !value ? t.confirmRequired : null;
  const problems = {
    target: tried && !plausibleTarget(target) ? t.targetInvalid : null,
    category: tried && !category ? t.categoryRequired : null,
    statement: tried && !statement.trim() ? t.statementRequired : null,
    email: !tried ? null : email.trim() ? EMAIL.test(email.trim()) ? null : t.emailInvalid
      : emailRequired ? t.emailRequiredHelp : null,
  };
  const declarationProblem = (tried && declaration === 'ncii' && (nciiFields.some(key => !ncii[key].trim())
    || !ncii.authorized || !ncii.goodFaith)) || (tried && declaration === 'copyright'
    && (copyrightFields.some(key => !copyright[key].trim()) || !copyright.goodFaith || !copyright.perjury));
  const invalid = Object.values(problems).some(Boolean) || declarationProblem;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const complete = plausibleTarget(target) && category && statement.trim()
      && (email.trim() ? EMAIL.test(email.trim()) : !emailRequired)
      && (declaration !== 'ncii' || nciiFields.every(key => ncii[key].trim()) && ncii.authorized && ncii.goodFaith)
      && (declaration !== 'copyright' || copyrightFields.every(key => copyright[key].trim())
        && copyright.goodFaith && copyright.perjury);
    if (!complete || !category) { setAttempted(count => count + 1); return; }
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

  const written = textAttributes(language, statement);
  const categories = categoriesFor(realm);
  return <form ref={form} noValidate onSubmit={event => void submit(event)} className="grid max-w-2xl gap-6"
    aria-label={t.title} data-invalid={invalid ? 'true' : undefined}>
    <Line label={t.targetLabel} value={target} onChange={setTarget} help={t.targetHelp} error={problems.target}
      maxLength={2048} />

    <Field invalid={Boolean(problems.category)}>
      <RadioGroup value={category ?? ''} onValueChange={details => setCategory((details.value || null) as ReportCategory | null)}
        className="gap-2 data-invalid:text-foreground dark:data-invalid:text-foreground">
        <RadioGroupLabel>{t.categoryLabel}</RadioGroupLabel>
        {categories.map(item => <RadioGroupItem key={item} value={item}>
          <span className="grid gap-0.5">
            <span className="font-medium">{keyed(t, 'cat', item)}</span>
            <span className="text-muted-foreground text-sm">{keyed(t, 'hint', item)}{isUrgent(item) ? ` ${t.urgent}` : ''}</span>
          </span>
        </RadioGroupItem>)}
      </RadioGroup>
      {problems.category ? <FieldError>{problems.category}</FieldError> : null}
    </Field>

    <Guidance category={category} t={t} />

    {declaration === 'ncii' ? <section aria-labelledby="ncii-heading" className="grid gap-4 rounded-2xl bg-muted/60 p-4">
      <h2 id="ncii-heading" className="flex items-center gap-2 font-semibold">
        <ShieldAlertIcon aria-hidden="true" className="size-4" />{t.nciiHeading}</h2>
      <p className="text-sm">{t.nciiNoImage}</p>
      <p role="note" className="text-sm font-medium">{t.nciiNotice}</p>
      <Confirm checked={ncii.authorized} error={unticked(ncii.authorized)}
        onChange={authorized => setNcii({ ...ncii, authorized })}>{t.nciiAuthorized}</Confirm>
      <Confirm checked={ncii.goodFaith} error={unticked(ncii.goodFaith)}
        onChange={goodFaith => setNcii({ ...ncii, goodFaith })}>{t.nciiGoodFaith}</Confirm>
      <Line label={t.nciiSupporting} help={t.nciiSupportingHelp} multiline maxLength={4000}
        value={ncii.supportingInformation} error={missing(ncii.supportingInformation)}
        onChange={supportingInformation => setNcii({ ...ncii, supportingInformation })} />
      <Line label={t.nciiSignature} value={ncii.signature} maxLength={300} error={missing(ncii.signature)}
        onChange={signature => setNcii({ ...ncii, signature })} />
    </section> : null}

    {declaration === 'copyright' ? <section aria-labelledby="copyright-heading"
      className="grid gap-4 rounded-2xl bg-muted/60 p-4">
      <h2 id="copyright-heading" className="font-semibold">{t.copyrightHeading}</h2>
      <p role="note" className="text-sm font-medium">{t.copyrightNotice}</p>
      <Line label={t.claimantName} value={copyright.claimantName} maxLength={300} error={missing(copyright.claimantName)}
        onChange={claimantName => setCopyright({ ...copyright, claimantName })} />
      <Line label={t.claimantAddress} value={copyright.claimantAddress} maxLength={500}
        error={missing(copyright.claimantAddress)}
        onChange={claimantAddress => setCopyright({ ...copyright, claimantAddress })} />
      <Line label={t.claimantPhone} type="tel" value={copyright.claimantPhone} maxLength={100}
        error={missing(copyright.claimantPhone)}
        onChange={claimantPhone => setCopyright({ ...copyright, claimantPhone })} />
      <Line label={t.claimedWork} multiline value={copyright.claimedWork} maxLength={1000}
        error={missing(copyright.claimedWork)} onChange={claimedWork => setCopyright({ ...copyright, claimedWork })} />
      <Line label={t.materialLocation} multiline value={copyright.materialLocation} maxLength={1000}
        error={missing(copyright.materialLocation)}
        onChange={materialLocation => setCopyright({ ...copyright, materialLocation })} />
      <Confirm checked={copyright.goodFaith} error={unticked(copyright.goodFaith)}
        onChange={goodFaith => setCopyright({ ...copyright, goodFaith })}>{t.copyrightGoodFaith}</Confirm>
      <Confirm checked={copyright.perjury} error={unticked(copyright.perjury)}
        onChange={perjury => setCopyright({ ...copyright, perjury })}>{t.copyrightPerjury}</Confirm>
      <Line label={t.copyrightSignature} value={copyright.signature} maxLength={300}
        error={missing(copyright.signature)} onChange={signature => setCopyright({ ...copyright, signature })} />
    </section> : null}

    <Line label={t.statementLabel} multiline value={statement} onChange={setStatement} maxLength={4000}
      help={t.statementHelp} error={problems.statement} lang={written.lang} dir={written.dir} />

    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{t.languageLabel}</span>
      <LanguageSelect value={language} onChange={setChosen} locale={locale} reading={reading} label={t.languageLabel} />
    </div>

    <Line label={t.emailLabel} type="email" value={email} onChange={setEmail} maxLength={320}
      help={emailRequired ? t.emailRequiredHelp : t.emailHelp} error={problems.email} />

    <p className="text-muted-foreground text-sm">{t.privateNote}</p>
    {failure ? <Alert variant="destructive" role="alert"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{failure.reason === 'limited' ? fill(t.retryIn, { time: waitText(failure.retryAfter, locale) })
        : failure.reason === 'invalid' ? t.refused : failure.reason === 'denied' ? t.targetUnknown : t.failed}
      </AlertDescription></Alert> : null}
    <div><Button type="submit" isLoading={busy} disabled={busy || !hydrated}>{busy ? t.sending : t.submit}</Button></div>
  </form>;
}
