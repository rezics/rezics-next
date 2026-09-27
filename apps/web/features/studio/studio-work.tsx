import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, ExternalLinkIcon, InfoIcon, PenLineIcon, TagIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { studioHref, textHref, type WorkTab, workHref } from './agent.ts';
import { ChapterList, type ChapterListProps } from './chapter-list.tsx';
import { CoverEditor, type CoverEditorProps } from './cover-editor.tsx';
import { type DetailsState, DetailsForm, type SaveDetails } from './details-form.tsx';
import type { StudioMessages } from './messages.ts';
import { Failure, formatDate, kindLabel, languageName, reviewModeText, SubmissionBadge } from './parts.tsx';
import type { StudioWork as Work, WorkSubmissions } from './read.ts';
import { RealmSubmit, type RealmSubmitProps } from './realm-submit.tsx';
import { StudioCover } from './studio-cover.tsx';
import { canonicalLanguage, type ClassificationPage, idOf, type Loaded, type MyText, workKind, writingLanguages }
  from './types.ts';

type T = ContractOf<StudioMessages>;

/** What one tab of a Work shows; the page reads only what its tab needs. */
export type WorkTabContent =
  | { tab: 'chapters'; chapters: Omit<ChapterListProps, 'agent' | 'book' | 'locale' | 'messages'> }
  | { tab: 'text'; texts: Loaded<MyText[]> }
  | { tab: 'details'; details: DetailsState; cover: Omit<CoverEditorProps, 'agent' | 'work' | 'locale' | 'messages'>;
    tags: Loaded<ClassificationPage>; saveDetails?: SaveDetails }
  | { tab: 'realms'; submit: Omit<RealmSubmitProps, 'agent' | 'work' | 'locale' | 'messages'>; history: WorkSubmissions };

/** The tabs a Work has: a Book is written in chapters and keeps a short text of its own. */
export function workTabs(types: readonly string[]): WorkTab[] {
  return workKind(types) === 'book' ? ['chapters', 'text', 'details', 'realms'] : ['text', 'details', 'realms'];
}

function Section({ id, title, help, actions, children }: {
  id: string; title: string; help?: string; actions?: ReactNode; children: ReactNode;
}) {
  return <section aria-labelledby={id} className="grid content-start gap-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid max-w-2xl gap-1">
        <h2 id={id} className="font-semibold text-xl">{title}</h2>
        {help ? <p className="text-pretty text-muted-foreground text-sm">{help}</p> : null}
      </div>
      {actions}
    </div>
    {children}
  </section>;
}

function Texts({ agent, work, texts, book, locale, t }: {
  agent: AgentOption; work: Work; texts: Loaded<MyText[]>; book: boolean; locale: UiLocale; t: T;
}) {
  const { header } = work;
  const list = texts.ok ? texts.data : [];
  const written = new Set(list.map(text => text.language.toLowerCase()));
  const own = canonicalLanguage(header.title.language);
  const next = [own, locale, ...writingLanguages].find(tag => !written.has(tag.toLowerCase())) ?? 'en';
  const writeHref = studioHref(agent, `/works/${idOf(header.id)}/write`);
  const state = (text: MyText) => text.publication === 'public' ? <Badge variant="success">{t.statePublished}</Badge>
    : text.publication === 'private' ? <Badge variant="secondary">{t.statePrivate}</Badge>
      : <Badge variant="outline">{t.stateDraft}</Badge>;
  return <Section id="studio-texts" title={book ? t.introduction : t.texts} help={book ? t.introductionHelp : t.textsHelp}>
    {!texts.ok ? <Alert variant="warning"><InfoIcon aria-hidden="true" />
      <AlertDescription>{t.textsUnknown}</AlertDescription></Alert> : null}
    {list.length ? <ul className="grid gap-3">{list.map(text => <li key={text.id} className="flex flex-wrap items-center
      justify-between gap-3 rounded-2xl border border-border/60 bg-card p-4">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{languageName(text.language, locale)}</span>{state(text)}</span>
      <Link href={textHref(agent, header.id, text.id, text.revision)} className={buttonVariants({ size: 'sm' })}>
        <PenLineIcon aria-hidden="true" />{t.continueWriting}</Link>
    </li>)}</ul> : texts.ok ? <div className="grid justify-items-start gap-3 rounded-2xl border border-border/80
      border-dashed p-6">
      <p className="text-muted-foreground text-sm">{book ? t.noIntroduction : t.noText}</p>
      <Link href={`${writeHref}?language=${encodeURIComponent(next)}`} className={buttonVariants()}>
        <PenLineIcon aria-hidden="true" />{book ? t.writeIntroduction : t.writeFirst}</Link>
    </div> : null}
    {/* A plain GET form, so writing in another language works before the page hydrates. */}
    <form method="get" action={localizedPath(writeHref, locale)} className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1.5 text-sm"><span className="font-medium">{t.writeAnother}</span>
        <NativeSelect name="language" defaultValue={next} size="sm" className="w-56">
          {writingLanguages.map(tag => <NativeSelectOption key={tag} value={tag} lang={tag}>
            {languageName(tag, locale)}</NativeSelectOption>)}
        </NativeSelect></label>
      <Button type="submit" variant="outline" size="sm"><PenLineIcon aria-hidden="true" />{t.startText}</Button>
    </form>
  </Section>;
}

function Tags({ tags, t }: { tags: Loaded<ClassificationPage>; t: T }) {
  return <section aria-labelledby="studio-tags" className="grid content-start gap-3">
    <div className="grid gap-1">
      <h3 id="studio-tags" className="font-semibold">{t.tagsHeading}</h3>
      <p className="text-muted-foreground text-sm">{t.tagsHelp}</p>
    </div>
    {tags.ok ? tags.data.items.length ? <ul className="flex flex-wrap gap-1.5">{tags.data.items.map(tag =>
      <li key={tag.sense}><Badge variant="secondary" lang={tag.name?.language}><TagIcon aria-hidden="true" />
        {tag.name?.value ?? tag.concept.slice(-8)}</Badge></li>)}</ul>
      : <p className="text-muted-foreground text-sm">{t.noTags}</p>
      : <p className="text-muted-foreground text-sm">{t.tagsFailed}</p>}
    <p className="text-muted-foreground text-xs">{t.tagsProposalsUnavailable}</p>
  </section>;
}

function History({ history, locale, t }: { history: WorkSubmissions; locale: UiLocale; t: T }) {
  if (!history.submissions.ok) {
    return history.submissions.failure === 'unavailable' ? <Failure title={t.reviewsFailed} retry t={t} />
      : <p className="text-muted-foreground text-sm">{t.noSubmissions}</p>;
  }
  const items = [...history.submissions.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!items.length) return <p className="text-muted-foreground text-sm">{t.noSubmissions}</p>;
  return <ul className="grid gap-2">{items.map(submission => {
    const realm = history.realms[submission.realm];
    return <li key={submission.id} className="grid gap-1.5 rounded-2xl border border-border/60 bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium" lang={realm?.language}>{realm?.name ?? t.realmFallback}</span>
        <SubmissionBadge state={submission.state} t={t} />
      </div>
      <p className="text-muted-foreground text-sm">{reviewModeText(realm?.reviewMode ?? null, t)}</p>
      {submission.publicReason ? <p className="text-sm">{submission.publicReason}</p> : null}
      <p className="text-muted-foreground text-xs">{t.submittedOn({ date: formatDate(submission.openedAt, locale) })}</p>
    </li>;
  })}</ul>;
}

function completionText(status: Work['header']['completionStatus'], t: T): string | null {
  switch (status) {
    case 'ongoing': return t.completionOngoing;
    case 'completed': return t.completionCompleted;
    case 'hiatus': return t.completionHiatus;
    default: return null;
  }
}

/**
 * One Work in Studio: who sees it and where it stands, then one tab at a time
 * (a Book's chapters, the Work's own text, its details and its Realms). Tabs
 * are addresses, so each opens directly and reads only what it shows.
 */
export function StudioWork({ agent, work, content, locale, messages }: {
  agent: AgentOption; work: Work; content: WorkTabContent; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const { header } = work;
  const kind = workKind(header.types);
  const tabs = workTabs(header.types);
  const labels: Record<WorkTab, string> = { chapters: t.tabChapters, text: kind === 'book' ? t.introduction : t.texts,
    details: t.details, realms: t.tabRealms };
  const completion = completionText(header.completionStatus, t);
  const language = canonicalLanguage(header.title.language);
  return <PageContainer className="grid gap-8">
    <div className="grid gap-5">
      <Link href={studioHref(agent)} className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'justify-self-start' })}>
        <ArrowLeftIcon aria-hidden="true" />{t.backToStudio}</Link>
      <header className="flex items-start gap-5">
        <StudioCover id={header.id} title={header.title} cover={header.cover} types={header.types} actingSubject={agent.iri}
          size="md" loading="eager" className="max-sm:w-20" />
        <div className="grid min-w-0 gap-3">
          <h1 lang={header.title.language} className="text-balance break-words font-semibold font-work-title text-3xl/tight
            sm:text-4xl/tight">{header.title.value}</h1>
          {header.tagline ? <p lang={header.tagline.language} className="text-pretty text-muted-foreground">
            {header.tagline.value}</p> : null}
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <span>{kindLabel(kind, t)}</span><span aria-hidden="true">·</span><span>{languageName(language, locale)}</span>
            {completion ? <><span aria-hidden="true">·</span><span>{completion}</span></> : null}
          </p>
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
    <nav aria-label={t.tabsLabel} className="-mx-1 -mb-3 flex gap-1 overflow-x-auto border-border/60 border-b px-1">
      {tabs.map(tab => <Link key={tab} href={workHref(agent, header.id, tab)} aria-current={content.tab === tab ? 'page' : undefined}
        className={cn('-mb-px shrink-0 border-transparent border-b-2 px-3 py-2 font-medium text-muted-foreground text-sm',
          'hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground')}>{labels[tab]}</Link>)}
    </nav>
    {content.tab === 'chapters' ? <Section id="studio-chapters" title={t.tabChapters} help={t.chaptersHelp}>
      <ChapterList agent={agent} book={{ id: header.id, mainVersion: header.mainVersion, title: header.title.value, language }}
        {...content.chapters} locale={locale} messages={messages} />
    </Section> : null}
    {content.tab === 'text' ? <Texts agent={agent} work={work} texts={content.texts} book={kind === 'book'} locale={locale} t={t} />
      : null}
    {content.tab === 'details' ? <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Section id="studio-details" title={t.details} help={t.detailsHelp}>
        {work.metadata.ok || work.metadata.failure !== 'unavailable'
          ? <DetailsForm agent={agent} work={idOf(header.id)} book={kind === 'book'} initialState={content.details}
            save={content.saveDetails} locale={locale} messages={messages} />
          : <Failure title={t.workFailed} retry t={t} />}
      </Section>
      <div className="grid content-start gap-10">
        <CoverEditor agent={agent} work={{ id: header.id, title: header.title, types: header.types }} {...content.cover}
          locale={locale} messages={messages} />
        <Tags tags={content.tags} t={t} />
      </div>
    </div> : null}
    {content.tab === 'realms' ? <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Section id="studio-realms" title={t.submitHeading} help={t.realmsHelp}>
        <RealmSubmit agent={agent} work={{ id: header.id, mainVersion: header.mainVersion, book: kind === 'book' }}
          {...content.submit} locale={locale} messages={messages} />
      </Section>
      <Section id="studio-submissions" title={t.submissionsHeading}>
        <History history={content.history} locale={locale} t={t} />
      </Section>
    </div> : null}
  </PageContainer>;
}
