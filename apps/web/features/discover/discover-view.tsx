import { materializeData } from 'native-i18n';
import { buttonVariants } from '@rezics/ui/button';
import type { EntityPickerLoad } from '@rezics/ui/entity-picker';
import type { UiLocale } from '../../i18n/define.ts';
import { BrowseConditions } from './browse-conditions.tsx';
import { browseCategories } from '../catalogue/registry.ts';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import type { SectionReason } from './api.ts';
import { browseMessages } from './browse-messages.ts';
import { browseHref, changeBrowse, type BrowseState } from './browse-state.ts';
import type { BrowseResult, LoadedBrowse } from './load.ts';
import { messages } from './messages.ts';
import { BrowseContinuation, ResourceList } from './resource-list.tsx';
import type { TopicItem } from './topic-picker.tsx';
import { ChapterTextResults } from './chapter-text.tsx';
import { chapterTextMessages } from './chapter-text-messages.ts';
import { chapterSearchState } from './chapter-text-read.ts';
import { BrowseTabs } from './browse-tabs.tsx';
import { selectionMessages } from './selection-messages.ts';
import { messages as searchMessages } from '../search/messages.ts';
import { BrowseSearchRecovery } from './search-recovery.tsx';

export interface DiscoverPageProps extends LoadedBrowse {
  topicLoad?: EntityPickerLoad<TopicItem>;
}
function reasonLabel(reason: SectionReason, locale: UiLocale): string {
  const t = browseMessages[locale];
  switch (reason) {
    case 'popular-in-followed-topics':
      return t.followedTopics;
    case 'popular':
      return t.popular;
    case 'communities-in-reader-languages':
      return t.readerLanguages;
    case 'communities':
      return t.communities;
    case 'new-sites':
      return t.newSites;
  }
}
function Failure({
  read,
  state,
  locale,
}: {
  read: Extract<BrowseResult<unknown>, { ok: false }>;
  state: BrowseState;
  locale: UiLocale;
}) {
  const t = browseMessages[locale];
  if (read.pending) return <p role="status" aria-busy="true">{messages[locale].preparing}</p>;
  const copy = materializeData(searchMessages[locale], { locale });
  if (read.failure === 'unsupported' || read.failure === 'invalid') return <div role="alert"
    className="grid gap-2 rounded-2xl border border-border p-5">
    <p>{read.failure === 'unsupported' ? copy.unsupportedTitle : copy.invalidTitle}</p>
    {read.failure === 'unsupported' ? <p className="text-muted-foreground text-sm">{copy.unsupportedHelp}</p> : null}
  </div>;
  return (
    <div
      role="alert"
      className="grid justify-items-start gap-3 rounded-2xl border border-border p-5"
    >
      <p>{read.moved ? t.changed : t.unavailable}</p>
      {read.moved ? (
        <Link
          href={browseHref({ ...state, cursor: null })}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t.first}
        </Link>
      ) : (
        <RetryButton label={t.retry} pendingLabel={t.loading} />
      )}
    </div>
  );
}
export function DiscoverView({
  state,
  topics,
  sections,
  results,
  chapterText,
  actingSubject,
  signedIn = true,
  avatarQuery,
  locale,
  topicLoad,
  checkedPages = 1,
  suggestions,
}: DiscoverPageProps) {
  const t = browseMessages[locale],
    copy = messages[locale], selection = selectionMessages[locale],
    search = materializeData(searchMessages[locale], { locale });
  if (!state)
    return (
      <PageContainer className="grid gap-5">
        <h1 className="font-semibold text-3xl">{copy.title}</h1>
        <p role="alert">{copy.badLinkTitle}</p>
        <Link href="/discover" className={buttonVariants({ variant: 'outline' })}>
          {copy.browseEverything}
        </Link>
      </PageContainer>
    );
  const resultHeading = state.q ? chapterTextMessages[locale].resources : state.tab === 'all' ? selection.results
    : browseCategories().find(category => category.id === state.tab)?.labels[locale] ?? selection.results;
  return (
    <PageContainer className="grid min-w-0 gap-7">
      <header className="grid min-w-0 gap-4">
        <h1 className="break-words font-semibold text-3xl tracking-tight sm:text-4xl">{state.q
          ? search.resultsFor({ phrase: state.q }) : copy.title}</h1>
        {state.q ? <p className="text-muted-foreground text-sm">{selection.within} · {state.scope.kind === 'global'
          ? search.global : search.scopeLabel}</p> : null}
        <BrowseTabs state={state} locale={locale} />
        <BrowseConditions
          state={state}
          locale={locale}
          actingSubject={actingSubject}
          signedIn={signedIn}
          topics={topics}
          load={topicLoad}
        />
        {actingSubject ? (
          <Link
            href={browseHref(changeBrowse(state, { personalized: !state.personalized }))}
            aria-current={state.personalized ? 'true' : undefined}
            className="justify-self-start text-muted-foreground text-sm underline underline-offset-4"
          >
            {t.personalize}
            {state.personalized ? ' ✓' : ''}
          </Link>
        ) : null}
      </header>
      {sections ? (
        sections.ok ? (
          sections.data.map((section) => (
            <section
              key={section.id}
              aria-label={reasonLabel(section.reason.kind, locale)}
              className="grid gap-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold text-xl">
                  {reasonLabel(section.reason.kind, locale)}
                </h2>
                {!state.section ? (
                  <Link
                    href={browseHref(changeBrowse(state, { section: section.id }))}
                    className="inline-flex min-h-8 items-center text-primary text-sm underline-offset-4 hover:underline"
                  >
                    {t.seeAll}
                  </Link>
                ) : null}
              </div>
              <ResourceList items={section.page.items} locale={locale} avatarQuery={avatarQuery} scope={state.scope} />
              {state.section ? (
                <BrowseContinuation page={section.page} state={state} locale={locale} />
              ) : null}
            </section>
          ))
        ) : (
          <Failure read={sections} state={state} locale={locale} />
        )
      ) : null}
      {results ? (
        <section aria-label={resultHeading} className="grid gap-4">
          <h2 className="font-semibold text-xl">{resultHeading}</h2>
          {results.ok ? <>
            {!results.data.items.length && !results.data.complete
              ? <p role="status" className="text-muted-foreground text-sm">{selection.scan} · {selection.checked}: {new Intl.NumberFormat(locale).format(checkedPages)}</p>
              : <ResourceList {...results.data} locale={locale} avatarQuery={avatarQuery} scope={state.scope} headingLevel={3} />}
            <BrowseContinuation page={results.data} state={state} locale={locale}
              moreLabel={!results.data.items.length && !results.data.complete ? selection.continue : undefined} />
            {suggestions ? <BrowseSearchRecovery read={suggestions} state={state} locale={locale} /> : null}
          </> : <Failure read={results} state={state} locale={locale} />}
        </section>
      ) : null}
      <ChapterTextResults read={chapterText ?? null} state={chapterSearchState(state)} locale={locale}
        actingSubject={actingSubject} signedIn={signedIn} />
    </PageContainer>
  );
}
