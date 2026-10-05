import type { CanonicalAddress } from '@rezics/model/address';
import { buttonVariants } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { MessagesSquareIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import Link from '../shell/localized-link.tsx';
import { RelationRows } from '../work-levels/connections.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { SummaryLink, type SummaryHref } from '../work-levels/names.tsx';
import type { Names } from '../work-levels/types.ts';
import { franchisesOf, relationRows } from '../work-levels/relation-rows.ts';
import { DiscussionList } from '../work-page/discussion.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import type { ScopeRealm } from '../work-page/scope-bar.tsx';
import { realmLabel } from '../work-page/scope-labels.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import { idOf } from '../work-page/route.ts';
import type { DiscussionPage, Loaded } from '../work-page/types.ts';
import type { Copy } from './messages.ts';
import type { PredicateLabels } from './predicate-labels.ts';
import { presentStatements } from './statement-groups.ts';
import type {
  EntitySection,
  HrefFor,
  RelationsPage,
  SectionId,
  StatementItem,
  StatementPage,
} from './types.ts';

/** The sections the generic page draws. Others the projection lists (contents, releases, a Work's recipe) belong to their own hosts. */
export const drawnSections: readonly SectionId[] = [
  'statements',
  'relations',
  'ratings',
  'reviews',
  'discussion',
];

/** What every section needs to draw itself: its link, the address map and the words. */
export interface SectionProps {
  section: EntitySection;
  hrefFor: HrefFor;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
}

const outline = buttonVariants({ variant: 'outline', size: 'sm' });

/** A section with nothing to list says so quietly; the heading already names what is missing. */
export function Quiet({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid justify-items-start gap-2 rounded-2xl bg-muted/60 px-5 py-4">
      <p className="font-medium">{title}</p>
      {body ? <p className="text-muted-foreground text-sm">{body}</p> : null}
      {children}
    </div>
  );
}

/** A summary's page under the caller's address map. */
export const summaryHref =
  (hrefFor: HrefFor): SummaryHref =>
  (summary) => {
    // Realms, contexts, concepts and Main Versions name no page target: they are shown, never linked.
    if (summary.base === null) return null;
    const address =
      'address' in summary ? (summary.address as CanonicalAddress | undefined) : undefined;
    return hrefFor({
      kind: 'resource',
      iri: summary.reference,
      base: summary.base,
      type: summary.type,
      ...(address ? { address } : {}),
    });
  };

export function Pages({
  cursor,
  next,
  section,
  hrefFor,
  messages,
}: {
  cursor: string | undefined;
  next: string | null;
  section: EntitySection['id'];
  hrefFor: HrefFor;
  messages: WorkPageMessages;
}) {
  if (!cursor && !next) return null;
  return (
    <nav aria-label={messages.pagination} className="flex flex-wrap justify-between gap-2">
      {cursor ? (
        <Link href={hrefFor({ kind: 'continue', section, cursor: null })} className={outline}>
          {messages.firstPage}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={hrefFor({ kind: 'continue', section, cursor: next })} className={outline}>
          {messages.nextPage}
        </Link>
      ) : null}
    </nav>
  );
}

export function Value({
  item,
  names,
  hrefFor,
  t,
}: {
  item: StatementItem;
  names: Names;
  hrefFor: HrefFor;
  t: Copy;
}) {
  if (item.kind === 'component-property') {
    // An owner's typed value: text keeps its own language and direction, a resource is named and linked like any other
    // value; anything else is shown as Main recorded it.
    const { lexical, language, direction, kind, ref } = item.value as {
      lexical?: unknown;
      language?: unknown;
      direction?: unknown;
      kind?: unknown;
      ref?: unknown;
    };
    if (kind === 'resource' && typeof ref === 'string' && names.has(ref)) {
      return (
        <SummaryLink
          summary={names.get(ref)}
          unavailable={t.unavailable}
          unnamed={t.unnamed}
          hrefFor={summaryHref(hrefFor)}
        />
      );
    }
    if (typeof lexical === 'string') {
      return (
        <span
          lang={typeof language === 'string' ? language : undefined}
          dir={direction === 'rtl' || direction === 'ltr' ? direction : 'auto'}
          className="break-words"
        >
          {lexical}
        </span>
      );
    }
    return <code className="break-all text-sm">{JSON.stringify(item.value)}</code>;
  }
  const value = item.value;
  if (value.kind === 'some-value')
    return <span className="text-muted-foreground">{t.valueSome}</span>;
  if (value.kind === 'no-value')
    return <span className="text-muted-foreground">{t.valueNone}</span>;
  if (value.kind === 'literal') {
    return (
      <span lang={value.language ?? undefined} dir="auto" className="break-words">
        {value.lexical}
      </span>
    );
  }
  return (
    <SummaryLink
      summary={names.get(value.iri)}
      unavailable={t.unavailable}
      unnamed={t.unnamed}
      hrefFor={summaryHref(hrefFor)}
    />
  );
}

/**
 * Where a statement holds, when it says: the continuities and Works it is recorded for, each by name, so a page read with
 * every continuity shows which one each claim belongs to. A place the reader has not reached is never named.
 */
export function HoldsIn({ item, names, t }: { item: StatementItem; names: Names; t: Copy }) {
  const where = item.qualifiers.applicability.flatMap((iri) => {
    const summary = names.get(iri);
    return summary?.status === 'available' ? [summary] : [];
  });
  if (!where.length) return null;
  return (
    <span data-holds-in className="ms-2 text-muted-foreground text-sm">
      {t.holdsIn}{' '}
      {where.map((summary, index) => (
        <span key={summary.reference}>
          {index ? ', ' : ''}
          <LocalizedText text={summary.name} as="span" />
        </span>
      ))}
    </span>
  );
}

/** One predicate's heading and its values, in the label column beside them from `sm` up. */
function StatementGroupView({
  heading,
  items,
  names,
  hrefFor,
  t,
}: {
  heading: ReactNode;
  items: readonly StatementItem[];
  names: Names;
  hrefFor: HrefFor;
  t: Copy;
}) {
  return (
    <div data-statement-group className="grid gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4">
      <h3 className="break-words font-medium text-muted-foreground text-sm">{heading}</h3>
      <ul className="grid min-w-0 gap-1">
        {items.map((item, index) => (
          <li key={`${item.revision}-${index}`} className="min-w-0">
            <Value item={item} names={names} hrefFor={hrefFor} t={t} />
            <HoldsIn item={item} names={names} t={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Accepted statements about the resource, grouped by predicate, continuing by Main's cursor. A predicate without a label
 * in the reader's language never shows a blank heading: its values gather under "Other facts".
 */
export function StatementsView({
  page,
  labels = new Map(),
  names,
  ownName,
  cursor,
  hrefFor,
  t,
  messages,
}: {
  page: Loaded<StatementPage>;
  labels?: PredicateLabels;
  names: Names;
  /** The page's own name, which its heading already shows. */
  ownName?: string;
  cursor: string | undefined;
  hrefFor: HrefFor;
  t: Copy;
  messages: WorkPageMessages;
}) {
  if (!page.ok) {
    return (
      <Region id="statements" title={t.statements}>
        <RegionFailure
          title={t.statementsUnavailable}
          failure={page.failure}
          messages={messages}
          restartHref={hrefFor({ kind: 'continue', section: 'statements', cursor: null })}
        />
      </Region>
    );
  }
  const { labelled, other } = presentStatements(page.data.groups, labels, ownName);
  return (
    <Region id="statements" title={t.statements}>
      {labelled.length || other.length ? (
        <div aria-label={t.statementsList} className="grid gap-5">
          {labelled.map((group) => (
            <StatementGroupView
              key={group.predicate}
              heading={<LocalizedText text={labels.get(group.predicate)!} />}
              items={group.items}
              names={names}
              hrefFor={hrefFor}
              t={t}
            />
          ))}
          {other.length ? (
            <StatementGroupView heading={t.otherFacts} items={other} names={names} hrefFor={hrefFor} t={t} />
          ) : null}
        </div>
      ) : (
        <Quiet title={t.noStatements} body={t.noStatementsBody} />
      )}
      <Pages
        cursor={cursor}
        next={page.data.nextCursor}
        section="statements"
        hrefFor={hrefFor}
        messages={messages}
      />
    </Region>
  );
}

/**
 * Relation occurrences where the resource takes any role. The rows are Main's
 * own rendering (labels in the reader's language, counterparts named by Main);
 * counterparts that are not page targets are named without a link.
 */
export function RelationsView({
  page,
  cursor,
  hrefFor,
  locale,
  t,
  messages,
}: {
  page: Loaded<RelationsPage>;
  cursor: string | undefined;
  hrefFor: HrefFor;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
}) {
  if (!page.ok) {
    return (
      <Region id="relations" title={t.relations}>
        <RegionFailure
          title={t.relationsUnavailable}
          failure={page.failure}
          messages={messages}
          restartHref={hrefFor({ kind: 'continue', section: 'relations', cursor: null })}
        />
      </Region>
    );
  }
  const rows = relationRows(page.data.items, { together: true });
  const franchises = franchisesOf(page.data.items);
  const levels = levelsCopy(locale);
  return (
    <Region id="relations" title={t.relations}>
      {rows.length || franchises.length ? (
        <div className="grid gap-5">
          {franchises.length ? (
            <div className="grid gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4">
              <h3 className="font-medium text-muted-foreground text-sm">{levels.franchises}</h3>
              <ul className="grid gap-1">
                {franchises.map((summary) => (
                  <li key={summary.reference}>
                    <SummaryLink
                      summary={summary}
                      unavailable={t.unavailable}
                      unnamed={t.unnamed}
                      hrefFor={summaryHref(hrefFor)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <RelationRows rows={rows} locale={locale} t={levels} hrefFor={summaryHref(hrefFor)} />
        </div>
      ) : (
        <Quiet title={t.noRelations} body={t.noRelationsBody} />
      )}
      <Pages
        cursor={cursor}
        next={page.data.next}
        section="relations"
        hrefFor={hrefFor}
        messages={messages}
      />
    </Region>
  );
}

/**
 * Replies reviewed in public Realms about the resource, and the way to start
 * one: "Discuss this chapter" leads to the composer with this resource as its
 * target, so the action is the same on every page.
 */
export function DiscussionView({
  page,
  realms,
  cursor,
  resource,
  subject,
  signedIn,
  hrefFor,
  locale,
  t,
  messages,
  anchor = 'discussion',
}: {
  /** The region's id; a host that already uses `discussion` for its own anchor names another. */
  anchor?: string;
  page: Loaded<DiscussionPage>;
  realms: ReadonlyMap<string, ScopeRealm['name']>;
  cursor: string | undefined;
  resource: string;
  /** What the resource is called in a sentence ("chapter"). */ subject: string;
  signedIn: boolean;
  hrefFor: HrefFor;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
}) {
  const compose = `/submit?target=${idOf(resource) ?? resource}`;
  const start = (
    <Link
      href={signedIn ? compose : signInPath(localizedPath(compose, locale))}
      className={buttonVariants({ size: 'sm', pill: true })}
      data-discuss
    >
      <MessagesSquareIcon aria-hidden="true" />
      {t.startDiscussion({ subject })}
    </Link>
  );
  if (!page.ok) {
    return (
      <Region id={anchor} title={t.discussion} aside={start}>
        <RegionFailure
          title={messages.discussionUnavailable}
          failure={page.failure}
          messages={messages}
          restartHref={hrefFor({ kind: 'continue', section: 'discussion', cursor: null })}
        />
      </Region>
    );
  }
  return (
    <Region id={anchor} title={t.discussion} aside={start}>
      {page.data.items.length ? (
        <DiscussionList
          items={page.data.items}
          locale={locale}
          messages={messages}
          realmLabel={(realm) =>
            realmLabel({ id: realm, name: realms.get(realm) ?? null }, messages, locale)
          }
        />
      ) : (
        <Quiet title={messages.noDiscussionGlobal}>{start}</Quiet>
      )}
      <Pages
        cursor={cursor}
        next={page.data.nextCursor}
        section="discussion"
        hrefFor={hrefFor}
        messages={messages}
      />
    </Region>
  );
}
