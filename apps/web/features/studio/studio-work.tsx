import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { ArrowLeftIcon, ExternalLinkIcon, InfoIcon, PenLineIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { studioHref } from './agent.ts';
import { type DetailsState, DetailsForm } from './details-form.tsx';
import { ManuscriptCover } from './manuscript-cover.tsx';
import type { StudioMessages } from './messages.ts';
import type { StudioWork as Work } from './read.ts';
import { languageName, publicationBadge, submissionState, textHref } from './studio-home.tsx';
import { idOf, writingLanguages } from './types.ts';

function Section({ id, title, help, children }: { id: string; title: string; help?: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="grid content-start gap-4">
    <div className="grid gap-1">
      <h2 id={id} className="font-semibold text-xl">{title}</h2>
      {help ? <p className="text-muted-foreground text-sm">{help}</p> : null}
    </div>
    {children}
  </section>;
}

/**
 * One Work in Studio: its text in each language with where it stands, its
 * details as readers see them, and what Realms decided. Writing a new language
 * is a plain GET form, so it works before the page hydrates.
 */
export function StudioWork({ agent, work, detailsAction, details, locale, messages }: {
  agent: AgentOption; work: Work; detailsAction: (previous: DetailsState, form: FormData) => Promise<DetailsState>;
  details: DetailsState; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const { header } = work;
  const texts = work.texts.ok ? work.texts.data : [];
  const written = new Set(texts.map(text => text.language.toLowerCase()));
  const next = [locale, ...writingLanguages].find(tag => !written.has(tag.toLowerCase())) ?? 'en';
  const writeHref = studioHref(agent, `/works/${idOf(header.id)}/write`);
  return <PageContainer className="grid gap-10">
    <div className="grid gap-5">
      <Link href={studioHref(agent)} className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'justify-self-start' })}>
        <ArrowLeftIcon aria-hidden="true" />{t.backToStudio}</Link>
      <header className="flex items-start gap-5">
        <ManuscriptCover cover={header.cover} title={header.title.value} language={header.title.language}
          fallbackKey={header.id} actingSubject={agent.iri} className="w-20 sm:w-28" />
        <div className="grid min-w-0 gap-3">
          <h1 lang={header.title.language} className="text-balance break-words font-semibold font-work-title text-3xl/tight
            sm:text-4xl/tight">{header.title.value}</h1>
          <p className="flex flex-wrap items-center gap-2">
            {header.disclosure === 'public' ? <Badge variant="success">{t.publicWork}</Badge>
              : <Badge variant="outline">{t.notPublished}</Badge>}
            {header.disclosure === 'public' ? <Link href={`/w/${idOf(header.id)}`}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{t.viewWork}
              <ExternalLinkIcon aria-hidden="true" /></Link> : null}
          </p>
        </div>
      </header>
    </div>
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Section id="studio-texts" title={t.texts} help={t.textsHelp}>
        {!work.texts.ok ? <Alert variant="warning"><InfoIcon aria-hidden="true" />
          <AlertDescription>{t.textsUnknown}</AlertDescription></Alert> : null}
        {texts.length ? <ul className="grid gap-3">{texts.map(text => <li key={text.id} className="flex flex-wrap items-center
          justify-between gap-3 rounded-2xl border border-border/60 bg-card p-4">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{languageName(text.language, locale)}</span>{publicationBadge(text.publication, t)}</span>
          <Link href={textHref(agent, header.id, text.id, text.revision)} className={buttonVariants({ size: 'sm' })}>
            <PenLineIcon aria-hidden="true" />{t.continueWriting}</Link>
        </li>)}</ul> : work.texts.ok ? <div className="grid justify-items-start gap-3 rounded-2xl border border-border/80
          border-dashed p-6">
          <p className="text-muted-foreground text-sm">{t.noText}</p>
          <Link href={`${writeHref}?language=${encodeURIComponent(next)}`} className={buttonVariants()}>
            <PenLineIcon aria-hidden="true" />{t.writeFirst}</Link>
        </div> : null}
        <form method="get" action={localizedPath(writeHref, locale)} className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1.5 text-sm"><span className="font-medium">{t.writeAnother}</span>
            <NativeSelect name="language" defaultValue={next} size="sm" className="w-56">
              {writingLanguages.map(tag => <NativeSelectOption key={tag} value={tag} lang={tag}>
                {languageName(tag, locale)}</NativeSelectOption>)}
            </NativeSelect></label>
          <Button type="submit" variant="outline" size="sm"><PenLineIcon aria-hidden="true" />{t.writeFirst}</Button>
        </form>
        {work.submissions.ok && work.submissions.data.length ? <div className="grid gap-2">
          <h3 className="font-medium text-sm">{t.submissionsHeading}</h3>
          <ul className="grid gap-2">{work.submissions.data.map(submission => {
            const state = submissionState(submission.state, t);
            return <li key={submission.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={state.variant}>{state.text}</Badge>
              <span className="text-muted-foreground">{work.realms[submission.realm] ?? t.realmFallback}</span>
              {submission.publicReason ? <span className="basis-full text-muted-foreground">{submission.publicReason}</span> : null}
            </li>;
          })}</ul>
        </div> : null}
      </Section>
      <Section id="studio-details" title={t.details} help={t.detailsHelp}>
        {work.metadata.ok || work.metadata.failure !== 'unavailable'
          ? <DetailsForm agent={agent} work={idOf(header.id)} action={detailsAction} initialState={details}
            locale={locale} messages={messages} />
          : <Alert variant="destructive"><AlertDescription>{t.workFailed}</AlertDescription></Alert>}
      </Section>
    </div>
  </PageContainer>;
}
