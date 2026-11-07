import { createContext, useContext, useRef, type ReactNode } from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { viewIsPublic, accountPublicationSource } from './account-profile-reading';
export { accountCollectionWindowReading } from './account-profile-reading';
import type { OverviewValue } from './overview';
import { Failed, Preview, sectionClass, useOverview, viewHref } from './overview-section';
import { isRecord, linkClass, linkColor } from './shared';
import {
  contributionCoordinateIsBounded,
  unavailableContributionActions,
  type AccountProfilePort,
  type AccountListFailure,
  type ContributionWindowOwner,
  type ContributionWindowOutcome,
} from './account-profile-port';

// Ordinary Subject compositions have no profile route or private action cohort.
// The public profile composition root supplies the live capabilities explicitly.
const noProfileRoute: AccountProfilePort = {
  useCollectionWindow: () => false,
  useContributionPage: () => null,
  useContributionRoute: () => false,
  retireContributionWindow: () => {},
  CollectionControls: () => null,
  ContributionControls: () => null,
  ContributionList: ({ children }) => <>{children}</>,
  contributionActions: unavailableContributionActions,
};
const AccountProfileContext = createContext<AccountProfilePort>(noProfileRoute);

export function AccountPageApplication({ profile, children }: { profile: AccountProfilePort; children: ReactNode }) {
  return <AccountProfileContext.Provider value={profile}>{children}</AccountProfileContext.Provider>;
}

export function accountListFailure(status: number): AccountListFailure {
  return status === 400
    ? 'invalid-cursor'
    : status === 401 || status === 403
      ? 'denied'
      : status === 202
        ? 'preparing'
        : 'unavailable';
}

export type AccountListSpec = {
  slot: string;
  view: 'posts' | 'reviews' | 'discussion' | 'collections';
  kind: 'accountPosts' | 'accountThreads' | 'accountCollections';
  title: (locale: string) => string;
  items: (body: Record<string, unknown>) => unknown;
  failure: (state: AccountListFailure) => ReactNode;
  recovery?: (rows: Record<string, unknown>[], locale: string) => ReactNode;
  row: (item: Record<string, unknown>, value: OverviewValue, index: number) => ReactNode;
};

/** The first page of one of the account's lists. A preview links to the view; a view links to the next page. */
export function AccountList({ props, spec }: { props: Record<string, unknown>; spec: AccountListSpec }) {
  const collectionPagesAdmitted = useOperation('account.collections');
  const profilePort = useContext(AccountProfileContext);
  const collectionWindows = profilePort.useCollectionWindow();
  const { CollectionControls, ContributionControls, ContributionList } = profilePort;
  const windowed = spec.kind === 'accountCollections' && props.paged === true && collectionWindows;
  const state = useOverview(props.id);
  const actionPage = profilePort.useContributionPage();
  const windowRoute = profilePort.useContributionRoute();
  const sectionRef = useRef<HTMLElement | null>(null);
  if (!state) return null;
  const { value, section } = state;
  if (!value.account) return null;
  const actionView =
    spec.view === 'posts' || spec.view === 'reviews' || spec.view === 'discussion' ? spec.view : undefined;
  if (!viewIsPublic(value.profile, spec.view)) {
    if (windowRoute) profilePort.retireContributionWindow();
    return null;
  }
  if (!section) return null;
  const id = String(props.id);
  const title = spec.title(value.locale);
  const options = { locale: value.locale as never };
  const view = viewHref(value, spec.view);
  const canOpenView = spec.kind !== 'accountCollections' || collectionPagesAdmitted;
  const actionProfile = value.profile;
  const windowOwner: ContributionWindowOwner | null =
    windowRoute && actionView && actionProfile
      ? { accountId: actionProfile.id, view: actionView, locale: value.locale, published: true }
      : null;
  const windowCursor = actionPage && actionPage.view === actionView ? actionPage.cursor : null;
  const windowControls = (
    outcome: ContributionWindowOutcome,
    next: string | null,
    failure?: 'denied' | 'preparing' | 'unavailable' | 'invalid-cursor',
  ) =>
    windowRoute && windowOwner && actionView ? (
      <ContributionControls
        owner={windowOwner}
        cursor={windowCursor}
        next={next}
        outcome={outcome}
        {...(failure ? { failure } : {})}
        title={title}
        region={sectionRef}
      />
    ) : null;
  const failedList = () =>
    windowRoute && windowOwner ? (
      <section
        ref={sectionRef}
        data-slot={spec.slot}
        data-state="failed"
        aria-labelledby={`${id}-title`}
        className={sectionClass}
        tabIndex={-1}
      >
        <h2 id={`${id}-title`} className="text-2xl font-semibold">
          {title}
        </h2>
        <p role="status" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {m.subject_section_failed({}, options)}
        </p>
        {windowControls('failed', null, 'unavailable')}
      </section>
    ) : (
      <Failed slot={spec.slot} id={id} title={title} locale={value.locale} />
    );
  if (!section.ok) {
    const failure = accountListFailure(section.status ?? 503);
    return (
      <section
        ref={windowRoute ? sectionRef : undefined}
        data-slot={spec.slot}
        aria-labelledby={`${id}-title`}
        className={sectionClass}
        tabIndex={windowRoute ? -1 : undefined}
      >
        <h2 id={`${id}-title`} className="text-2xl font-semibold">
          {title}
        </h2>
        {spec.failure(failure)}
        {windowRoute && actionView ? (
          windowControls('failed', null, failure)
        ) : windowed && failure !== 'denied' ? (
          <CollectionControls locale={value.locale} failed invalid={failure === 'invalid-cursor'} />
        ) : failure === 'invalid-cursor' ? (
          canOpenView && view ? (
            <a data-slot="restart" href={view} className={`${linkClass} inline-flex min-h-11 items-center`}>
              {m.public_account_start_again({}, options)}
            </a>
          ) : null
        ) : failure !== 'denied' ? (
          <a data-slot="retry" href="" className={`${linkClass} inline-flex min-h-11 items-center`}>
            {m.public_account_retry({}, options)}
          </a>
        ) : null}
      </section>
    );
  }
  if (section.read.kind !== spec.kind) return failedList();
  const listed = spec.items(section.body);
  if (!Array.isArray(listed)) return failedList();
  const limit = typeof props.limit === 'number' ? props.limit : listed.length;
  const rows = listed.filter(isRecord);
  if (spec.kind !== 'accountCollections' && rows.length > 20) return failedList();
  const items = rows.slice(0, limit);
  const rawNext = section.body.next;
  if (
    actionView &&
    windowRoute &&
    rawNext !== undefined &&
    rawNext !== null &&
    !contributionCoordinateIsBounded(rawNext)
  )
    return failedList();
  const next = typeof rawNext === 'string' && rawNext ? rawNext : null;
  const paged = props.paged === true;
  const list = (
    <ul data-slot={`${spec.slot}-items`} className="space-y-4 break-words">
      {items.map((item, index) => spec.row(item, value, index))}
    </ul>
  );
  const actionPublication =
    actionPage && actionProfile ? accountPublicationSource(actionPage.page, actionProfile.id) : null;
  const actionList =
    paged &&
    actionView &&
    actionProfile &&
    actionPublication &&
    actionPage &&
    actionPage.view === actionView &&
    actionPage.page.account?.id === actionProfile.id &&
    value.account?.id === actionProfile.id ? (
      <ContributionList
        accountId={actionProfile.id}
        view={actionView}
        cursor={actionPage.cursor}
        locale={value.locale}
        page={actionPage.page}
        read={section.read}
        source={section.body}
        selection={section.body.actionSelection}
        publication={actionPublication}
        postsPublished={actionProfile.publicViews.posts}
        reviewsPublished={actionProfile.publicViews.reviews}
        rows={items}
      >
        {list}
      </ContributionList>
    ) : (
      list
    );
  if (paged) {
    if (items.length === 0 && !next)
      return (
        <section
          ref={windowRoute ? sectionRef : undefined}
          data-slot={spec.slot}
          aria-labelledby={`${id}-title`}
          className={sectionClass}
          tabIndex={windowRoute ? -1 : undefined}
        >
          <h2 id={`${id}-title`} className="sr-only" tabIndex={-1}>
            {title}
          </h2>
          {actionView ? spec.recovery?.(items, value.locale) : null}
          <Empty className="border p-6">
            <EmptyHeader>
              <EmptyTitle className="sr-only">{title}</EmptyTitle>
              <EmptyDescription>{m.agent_empty({}, { locale: value.locale as never })}</EmptyDescription>
            </EmptyHeader>
          </Empty>
          {windowRoute && actionView && windowOwner ? windowControls('admitted', next) : null}
          {windowed && <CollectionControls locale={value.locale} />}
        </section>
      );
    return (
      <section
        ref={windowRoute ? sectionRef : undefined}
        data-slot={spec.slot}
        aria-labelledby={`${id}-title`}
        className={sectionClass}
        tabIndex={windowRoute ? -1 : undefined}
      >
        <h2 id={`${id}-title`} className="sr-only" tabIndex={-1}>
          {title}
        </h2>
        {actionView ? spec.recovery?.(items, value.locale) : null}
        {actionList}
        {windowRoute && actionView && windowOwner ? (
          windowControls('admitted', next)
        ) : windowed ? (
          <CollectionControls next={next} locale={value.locale} />
        ) : (
          (!windowRoute || !actionView) &&
          next &&
          (spec.kind !== 'accountCollections' || collectionPagesAdmitted) && (
            <a
              data-slot="continuation"
              rel="next"
              href={`?cursor=${encodeURIComponent(next)}`}
              className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center text-sm font-medium hover:underline`}
            >
              {m.threads_next_page({}, { locale: value.locale as never })}
            </a>
          )
        )}
      </section>
    );
  }
  if (items.length === 0 && (!next || !canOpenView)) return null;
  return (
    <Preview
      slot={spec.slot}
      id={id}
      title={title}
      count={next === null ? { value: rows.length, relation: 'exact' } : undefined}
      more={next !== null || rows.length > items.length}
      href={canOpenView ? view : null}
      locale={value.locale}
    >
      {list}
    </Preview>
  );
}
