import { AccountBiography } from './account-context/biography';
import { Fragment, type ReactNode } from 'react';
import { Cover } from '@rezics/ui/cover';
import { ContentItem } from '@rezics/ui/content-item';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { subjectHref, type SubjectHrefInput } from '../subject/subject-href';
import { displayRating } from '../features/pages/subject-ratings';
import { MatchEvidenceView, ResultRow, localizedLabel } from './results';
import {
  discoveryKey,
  isAccountHit,
  isPublicDiscoveryHit,
  type AccountDiscoverySummary,
  type DiscoveryViewerFact,
  type DiscoveryViewerQuestion,
  type DiscoveryState,
  type DiscoveryHit,
} from './discovery';
import { DiscoveryPublicRow } from './discovery-public-rows';

function messageOptions(locale?: string) {
  return locale === undefined ? {} : { locale: locales.find((value) => value === locale) ?? 'en' };
}

function viewerFactsUnavailable(page: Extract<DiscoveryState, { status: 'ready' }>['page']): boolean {
  return page.viewerFacts !== undefined && page.viewerFacts !== null && page.viewerFacts.state === 'unavailable';
}

function OmittedKindsNotice({
  omitted,
  locale,
}: {
  omitted: Extract<DiscoveryState, { status: 'ready' }>['page']['kinds']['omitted'];
  locale: string;
}) {
  if (!omitted?.length) return null;
  const options = messageOptions(locale);
  return (
    <ul role="status" className="mb-2 space-y-1 text-sm text-muted-foreground">
      {omitted.map(({ id, labels, state }) => {
        const kind = localizedLabel(labels, locale).text || id;
        return (
          <li key={id}>
            {state === 'preparing'
              ? m.discovery_kind_preparing({ kind }, options)
              : m.discovery_kind_unavailable({ kind }, options)}
          </li>
        );
      })}
    </ul>
  );
}

function stateText(state: string, locale: string): string {
  const options = messageOptions(locale);
  switch (state) {
    case 'planned':
      return m.library_state_planned({}, options);
    case 'in_progress':
      return m.library_state_in_progress({}, options);
    case 'completed':
      return m.library_state_completed({}, options);
    case 'paused':
      return m.library_state_paused({}, options);
    case 'dropped':
      return m.library_state_dropped({}, options);
    default:
      return m.library_other({}, options);
  }
}

function ViewerFactsRow({
  title,
  row,
  question,
  locale,
}: {
  title: string;
  row: DiscoveryViewerFact;
  question: DiscoveryViewerQuestion | null;
  locale: string;
}) {
  const options = messageOptions(locale);
  const labels: string[] = [];
  if (row.entry.state === 'absent') labels.push(m.discovery_not_in_library({}, options));
  if (row.entry.state === 'present')
    labels.push(m.library_entry_state_label({ title, state: stateText(row.entry.entryState ?? '', locale) }, options));
  if (row.vote.state === 'present' && question)
    labels.push(
      m.subject_ratings_yours(
        {
          score: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
            displayRating(row.vote.units, question.scale),
          ),
        },
        options,
      ),
    );
  if (row.vote.state === 'absent') labels.push(m.subject_rating_control_unrated({}, options));
  if (labels.length === 0) return null;
  return (
    <li
      data-slot="discovery-viewer-facts"
      className="ml-6 list-none rounded-md border px-3 py-2 text-sm text-muted-foreground"
    >
      {labels.join(' · ')}
    </li>
  );
}

/** Only a current native handle can address the supported public account route. */
export function discoveryAccountHref(account: AccountDiscoverySummary, locale: string): string | undefined {
  return account.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account.handle)
    ? `/${encodeURIComponent(locale)}/@${encodeURIComponent(account.handle)}`
    : undefined;
}

function AccountRow({
  account,
  kind,
  locale,
  subjectHrefFor,
}: {
  account: AccountDiscoverySummary;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  const options = messageOptions(locale);
  const title =
    account.displayName || (account.handle ? `@${account.handle}` : m.discovery_unnamed_account({}, options));
  const href = discoveryAccountHref(account, locale);
  const verified = account.verifiedAgent;
  return (
    <ContentItem
      data-discovery-account={account.id}
      title={title}
      {...(href !== undefined ? { href } : {})}
      visual={
        <div className="w-[72px] sm:w-24">
          <Cover
            subject={{ id: account.id, title, types: [] }}
            cover={account.avatar}
            ratio="1:1"
            size="fill"
            src={coverSrc}
            decorative
          />
        </div>
      }
      metadata={
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{kind}</p>
          {account.handle && <p className="break-words text-sm text-muted-foreground">@{account.handle}</p>}
          <AccountBiography account={account} locale={locale} />
          {verified && (
            <a
              className="text-primary underline underline-offset-4"
              href={
                subjectHrefFor?.({ id: verified.id, label: verified.label }) ??
                subjectHref({ id: verified.id, label: verified.label }, locale).href
              }
            >
              {m.discovery_verified_as({ name: verified.label }, options)}
            </a>
          )}
        </div>
      }
    />
  );
}

/** The same region is used by the live page and every mixed-card story. No row performs a read. Locale is optional for DiscoveryKinds. */
export function discoveryMessage(status: DiscoveryState['status'], locale?: string): string {
  const options = messageOptions(locale);
  switch (status) {
    case 'loading':
      return m.discovery_loading({}, options);
    case 'not-ready':
      return m.discovery_not_ready({}, options);
    case 'preparing':
      return m.discovery_preparing({}, options);
    case 'closed':
      return m.discovery_closed({}, options);
    case 'restart':
      return m.discovery_restart({}, options);
    case 'invalid':
      return m.discovery_invalid({}, options);
    case 'unsupported':
      return m.discovery_unsupported({}, options);
    case 'denied':
      return m.discovery_denied({}, options);
    case 'ready':
      return m.search_no_results({}, options);
    default:
      return m.search_failed({}, options);
  }
}

export function DiscoveryResults({
  state,
  locale,
  yearProperties = [],
  factDefinitions,
  restartHref,
  subjectHrefFor,
  renderPersonal,
}: {
  renderPersonal?: ((hit: DiscoveryHit, title: string) => ReactNode) | undefined;
  state: DiscoveryState;
  locale: string;
  yearProperties?: string[];
  factDefinitions?: import('./work-context/facts').ResultFactDefinitions | undefined;
  restartHref?: string | undefined;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  if (state.status !== 'ready' || state.page.hits.length === 0) {
    const options = messageOptions(locale);
    const message = discoveryMessage(state.status, locale);
    return (
      <Empty
        className="border"
        role={
          ['unavailable', 'restart', 'closed', 'invalid', 'unsupported', 'denied'].includes(state.status)
            ? 'alert'
            : 'status'
        }
        aria-busy={state.status === 'loading'}
      >
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{message}</EmptyTitle>
        </EmptyHeader>
        {state.status === 'ready' && viewerFactsUnavailable(state.page) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.discovery_viewer_unavailable({}, options)}
          </p>
        ) : null}
        {state.status === 'ready' ? <OmittedKindsNotice omitted={state.page.kinds.omitted} locale={locale} /> : null}
        {restartHref && state.status !== 'ready' && state.status !== 'loading' && (
          <a data-discovery-restart href={restartHref} className={buttonVariants({ variant: 'outline' })}>
            {state.status === 'restart' ? m.discovery_restart_action({}, options) : m.search_facet_retry({}, options)}
          </a>
        )}
      </Empty>
    );
  }
  const kinds = Object.fromEntries(state.page.kinds.values.map((kind) => [kind.id, kind.labels]));
  const viewer = state.page.viewerFacts;
  const viewerRows = new Map(viewer?.state === 'current' ? viewer.rows.map((row) => [row.rowKey, row]) : []);
  const viewerQuestion = viewer?.state === 'current' ? viewer.question : null;
  return (
    <>
      <OmittedKindsNotice omitted={state.page.kinds.omitted} locale={locale} />
      {viewerFactsUnavailable(state.page) ? (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          {m.discovery_viewer_unavailable({}, messageOptions(locale))}
        </p>
      ) : null}
      <ul role="list" className="space-y-2" data-slot="discovery-results">
        {state.page.hits.map((hit) => {
          const kind = localizedLabel(kinds[hit.key.kind] ?? {}, locale).text || hit.key.kind;
          if (isAccountHit(hit))
            return (
              <Fragment key={discoveryKey(hit)}>
                <AccountRow account={hit.summary.value} kind={kind} locale={locale} subjectHrefFor={subjectHrefFor} />
                <li className="ml-6 list-none">
                  <MatchEvidenceView evidence={hit.matchEvidence} locale={locale} />
                  {renderPersonal?.(hit, hit.summary.value.displayName ?? hit.summary.value.handle ?? kind)}
                </li>
              </Fragment>
            );
          if (isPublicDiscoveryHit(hit))
            return (
              <Fragment key={discoveryKey(hit)}>
                <DiscoveryPublicRow
                  hit={hit}
                  actions={
                    hit.summary.kind === 'space' || hit.summary.kind === 'collection'
                      ? renderPersonal?.(hit, hit.summary.value.title)
                      : undefined
                  }
                  entry={
                    state.page.spaceEntries?.reader === null
                      ? state.page.spaceEntries.rows.find((row) => row.id === hit.key.id)
                      : undefined
                  }
                  targetTypes={kinds}
                  kind={kind}
                  locale={locale}
                  subjectHrefFor={subjectHrefFor}
                  memberKindLabel={(type) => localizedLabel(kinds[type] ?? {}, locale).text || type}
                />
                <li className="ml-6 list-none">
                  <MatchEvidenceView evidence={hit.matchEvidence} locale={locale} />
                </li>
              </Fragment>
            );
          const summary = hit.summary.value;
          const label = summary.label;
          const contextLists = hit.contexts
            ? [
                { key: 'credits', label: m.subject_credits({}, messageOptions(locale)), value: hit.contexts.credits },
                {
                  key: 'appearances',
                  label: m.subject_appearances({}, messageOptions(locale)),
                  value: hit.contexts.appearances,
                },
              ].filter(({ value }) => value.items.length > 0)
            : [];
          return (
            <Fragment key={discoveryKey(hit)}>
              <ResultRow
                hit={{
                  id: hit.key.id,
                  type: hit.key.kind,
                  ...hit,
                  labels: hit.labels ?? (label ? { [label.language]: label.value } : {}),
                  summary,
                }}
                locale={locale}
                hitTypes={kinds}
                yearProperties={yearProperties}
                factDefinitions={factDefinitions}
                subjectHrefFor={subjectHrefFor}
              />
              {viewerRows.get(discoveryKey(hit)) ? (
                <ViewerFactsRow
                  title={label?.value ?? summary.label?.value ?? hit.key.id}
                  row={viewerRows.get(discoveryKey(hit))!}
                  question={viewerQuestion}
                  locale={locale}
                />
              ) : null}
              {renderPersonal ? (
                <li
                  data-discovery-personal-row={discoveryKey(hit)}
                  className="ml-6 list-none rounded-md border px-3 py-2"
                >
                  {renderPersonal(hit, label?.value ?? hit.key.id)}
                </li>
              ) : null}
              {contextLists.map(({ key, label: heading, value }) => (
                <li key={`${discoveryKey(hit)}:${key}`} className="ml-6 list-none rounded-md border px-3 py-2 text-sm">
                  <p className="font-medium">{heading}</p>
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {value.items.map((context) => {
                      const contextLabel = localizedLabel(context.labels, locale).text || context.id;
                      return (
                        <li key={context.id}>
                          <a
                            className="text-primary underline underline-offset-4"
                            href={
                              subjectHrefFor?.({ id: context.id, label: contextLabel }) ??
                              subjectHref({ id: context.id, label: contextLabel }, locale).href
                            }
                          >
                            {contextLabel}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}
