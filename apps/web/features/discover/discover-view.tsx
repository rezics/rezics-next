import { buttonVariants } from '@rezics/ui/button';
import type { EntityPickerLoad } from '@rezics/ui/entity-picker';
import type { UiLocale } from '../../i18n/define.ts';
import { DiscoverBrowseConditions } from '../query/condition-bar.tsx';
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
  actingSubject,
  avatarQuery,
  locale,
  topicLoad,
}: DiscoverPageProps) {
  const t = browseMessages[locale],
    copy = messages[locale];
  const tabs = [
    { id: 'all', label: t.all },
    ...browseCategories().map((category) => ({ id: category.id, label: category.labels[locale] })),
  ];
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
  return (
    <PageContainer className="grid min-w-0 gap-7">
      <header className="grid min-w-0 gap-4">
        <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">{copy.title}</h1>
        <DiscoverBrowseConditions
          state={state}
          locale={locale}
          actingSubject={actingSubject}
          topics={topics}
          load={topicLoad}
        />
        <nav aria-label={t.type} className="flex min-w-0 max-w-full gap-1 overflow-x-auto pb-1">
          {tabs.map(({ id: tab, label }) => (
            <Link
              key={tab}
              documentNavigation
              prefetch={false}
              href={browseHref(changeBrowse(state, { tab }))}
              aria-current={state.tab === tab && !state.section ? 'page' : undefined}
              className="inline-flex h-9 shrink-0 items-center rounded-full px-4 font-medium text-sm outline-none
            hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-foreground
            aria-[current=page]:text-background"
            >
              {label}
            </Link>
          ))}
        </nav>
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
                    className="text-primary text-sm underline-offset-4 hover:underline"
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
        results.ok ? (
          <section
            aria-label={tabs.find((tab) => tab.id === state.tab)?.label ?? t.type}
            className="grid gap-4"
          >
            <ResourceList items={results.data.items} locale={locale} avatarQuery={avatarQuery} scope={state.scope}
              headingLevel={2} />
            <BrowseContinuation page={results.data} state={state} locale={locale} />
          </section>
        ) : (
          <Failure read={results} state={state} locale={locale} />
        )
      ) : null}
    </PageContainer>
  );
}
