import { useOperation } from '../../kernel/exposure';
import { Cover } from '@rezics/ui/cover';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import type { ReactNode } from 'react';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { accountOf, viewIsPublic } from './account-read';
import { Failed, Preview, sectionClass, useOverview, viewHref, type OverviewValue } from './overview';
import { isRecord, linkClass, linkColor, webUrl } from './shared';
import { threadHref as canonicalThreadHref, threadTitle } from '../../threads/thread-href';
import { DocumentValue, readableDocument } from './values';

function dateText(value: unknown, locale: string): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
    : null;
}

export function accountSchemaType(profile: { kind: string; automated?: boolean }): string {
  return profile.kind === 'organization'
    ? 'schema:Organization'
    : profile.automated
      ? 'schema:SoftwareApplication'
      : 'schema:Person';
}

/**
 * The agent's own presentation, which stands in for the subject's header: avatar in a square frame, display name,
 * handle, bio and links. Facts about the agent stay statements further down the page.
 */
export function AccountIdentity(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  if (!state?.section?.ok || state.section.read.kind !== 'account') return null;
  const { value } = state;
  const profile = accountOf(state.section.body);
  if (!profile) return null;
  const name = profile.displayName ?? (profile.handle ? `@${profile.handle}` : value.unlabelled);
  const subject = {
    id: profile.id,
    title: name,
    types: [accountSchemaType(profile)],
  };
  const avatar = (size: 'sm' | 'md') => (
    <Cover
      subject={subject}
      cover={profile.avatar}
      size={size}
      ratio="1:1"
      src={coverSrc}
      suitability={value.reader.suitability}
      labels={value.labels.cover}
      {...(size === 'md' ? { priority: true } : {})}
      decorative
    />
  );
  const links = profile.links.filter((link) => webUrl(link.url));
  return (
    <div
      data-slot="agent-profile-card"
      className="rounded-2xl border border-border/60 bg-card p-4 shadow-(--aura-shadow-card) sm:p-6"
    >
      <div data-slot="agent-header" className="flex min-w-0 gap-4 sm:gap-6">
        <div className="shrink-0">
          <div className="sm:hidden">{avatar('sm')}</div>
          <div className="hidden w-40 sm:block">{avatar('md')}</div>
        </div>
        <div className="min-w-0 flex-1 space-y-2 in-data-[density=compact]:space-y-1.5">
          <h1 className="min-w-0 font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl in-data-[heading-scale=lg]:sm:text-5xl">
            {name}
          </h1>
          {profile.handle && (
            <p data-slot="agent-handle" className="truncate text-sm text-muted-foreground">
              {`@${profile.handle}`}
            </p>
          )}
          {profile.bio && <p className="max-w-prose leading-7 text-pretty whitespace-pre-line">{profile.bio}</p>}
          {profile.automated && value.operator && (
            <p data-slot="agent-operator" className="text-sm text-muted-foreground">
              {m.agent_operated_by({}, { locale: value.locale as never })}{' '}
              <value.link
                href={`/${encodeURIComponent(value.locale)}/@${encodeURIComponent(value.operator.handle ?? '')}`}
              >
                {value.operator.displayName || value.operator.handle}
              </value.link>
            </p>
          )}
          {links.length > 0 && (
            <ul
              aria-label={m.agent_links({}, { locale: value.locale as never })}
              className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
            >
              {links.map((link) => (
                <li key={link.url}>
                  <a
                    className={`${linkClass} ${linkColor} font-medium`}
                    href={link.url}
                    rel="nofollow noopener noreferrer ugc"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

type ListSpec = {
  slot: string;
  view: 'posts' | 'reviews' | 'collections';
  kind: 'accountPosts' | 'accountThreads' | 'accountCollections';
  title: (locale: string) => string;
  items: (body: Record<string, unknown>) => unknown;
  row: (item: Record<string, unknown>, value: OverviewValue, index: number) => ReactNode;
};

/** The first page of one of the account's lists. A preview links to the view; a view links to the next page. */
function AccountList({ props, spec }: { props: Record<string, unknown>; spec: ListSpec }) {
  const collectionPagesAdmitted = useOperation('account.collections');
  const state = useOverview(props.id);
  if (!state?.section || !state.value.account) return null;
  const { value, section } = state;
  if (!viewIsPublic(value.profile, spec.view)) return null;
  const id = String(props.id);
  const title = spec.title(value.locale);
  if (!section.ok || section.read.kind !== spec.kind)
    return <Failed slot={spec.slot} id={id} title={title} locale={value.locale} />;
  const listed = spec.items(section.body);
  if (!Array.isArray(listed)) return <Failed slot={spec.slot} id={id} title={title} locale={value.locale} />;
  const limit = typeof props.limit === 'number' ? props.limit : listed.length;
  const items = listed.filter(isRecord).slice(0, limit);
  const next = typeof section.body.next === 'string' && section.body.next ? section.body.next : null;
  const paged = props.paged === true;
  const list = (
    <ul data-slot={`${spec.slot}-items`} className="space-y-4 break-words">
      {items.map((item, index) => spec.row(item, value, index))}
    </ul>
  );
  if (paged) {
    if (items.length === 0)
      return (
        <section data-slot={spec.slot} aria-labelledby={`${id}-title`} className={sectionClass}>
          <h2 id={`${id}-title`} className="sr-only">
            {title}
          </h2>
          <Empty className="border p-6">
            <EmptyHeader>
              <EmptyTitle className="sr-only">{title}</EmptyTitle>
              <EmptyDescription>{m.agent_empty({}, { locale: value.locale as never })}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </section>
      );
    return (
      <section data-slot={spec.slot} aria-labelledby={`${id}-title`} className={sectionClass}>
        <h2 id={`${id}-title`} className="sr-only">
          {title}
        </h2>
        {list}
        {next && (spec.kind !== 'accountCollections' || collectionPagesAdmitted) && (
          <a
            data-slot="continuation"
            rel="next"
            href={`?cursor=${encodeURIComponent(next)}`}
            className={`${linkClass} ${linkColor} text-sm font-medium hover:underline`}
          >
            {m.threads_next_page({}, { locale: value.locale as never })}
          </a>
        )}
      </section>
    );
  }
  if (items.length === 0) return null;
  return (
    <Preview
      slot={spec.slot}
      id={id}
      title={title}
      count={next === null ? { value: items.length, relation: 'exact' } : undefined}
      more={next !== null}
      href={viewHref(value, spec.view)}
      locale={value.locale}
    >
      {list}
    </Preview>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** A post or opening post body, clipped so a long one cannot push the list off the page. */
function Excerpt({ body, value }: { body: unknown; value: OverviewValue }) {
  const document = readableDocument(body);
  if (!document) return null;
  return (
    <div className="max-h-40 overflow-hidden" data-slot="excerpt">
      <DocumentValue document={document} lang={undefined} labels={value.labels} />
    </div>
  );
}

function threadHref(locale: string, thread: { id: unknown; title?: unknown }): string {
  const id = typeof thread.id === 'string' ? thread.id : String(thread.id ?? '');
  const title = typeof thread.title === 'string' ? thread.title : null;
  return `/${encodeURIComponent(locale)}${canonicalThreadHref({ id, title: threadTitle({ title }) })}`;
}

export function AccountPosts(props: Record<string, unknown>) {
  return (
    <AccountList
      props={props}
      spec={{
        slot: 'account-posts',
        view: 'posts',
        kind: 'accountPosts',
        title: (locale) => m.subject_posts({}, { locale: locale as never }),
        items: (body) => body.posts,
        row: (post, value, index) => {
          const thread = isRecord(post.thread) ? post.thread : undefined;
          const title =
            typeof thread?.title === 'string' && thread.title
              ? thread.title
              : m.threads_untitled({}, { locale: value.locale as never });
          const when = dateText(post.createdAt, value.locale);
          const Link = value.link;
          return (
            <li key={typeof post.id === 'string' ? post.id : index} className="space-y-1">
              <Quiet>
                <span className={`${linkClass} ${linkColor} font-medium`}>
                  <Link href={threadHref(value.locale, { id: post.threadId, title: thread?.title })}>{title}</Link>
                </span>
                {when && ` · ${when}`}
              </Quiet>
              <Excerpt body={post.body} value={value} />
            </li>
          );
        },
      }}
    />
  );
}

export function AccountThreads(props: Record<string, unknown>) {
  return (
    <AccountList
      props={props}
      spec={{
        slot: props.threadKind === 'review' ? 'account-reviews' : 'account-threads',
        view: 'reviews',
        kind: 'accountThreads',
        title: (locale) =>
          props.threadKind === 'review'
            ? m.subject_reviews({}, { locale: locale as never })
            : m.subject_discussion({}, { locale: locale as never }),
        items: (body) => body.threads,
        row: (thread, value, index) => {
          const title =
            typeof thread.title === 'string' && thread.title
              ? thread.title
              : m.threads_untitled({}, { locale: value.locale as never });
          const first = isRecord(thread.firstPost) ? thread.firstPost : undefined;
          const when = dateText(first?.createdAt, value.locale);
          const Link = value.link;
          return (
            <li key={typeof thread.id === 'string' ? thread.id : index} className="space-y-1">
              <p className="font-medium">
                <span className={`${linkClass} ${linkColor}`}>
                  <Link href={threadHref(value.locale, { id: thread.id, title: thread.title })}>{title}</Link>
                </span>
              </p>
              {when && <Quiet>{when}</Quiet>}
              <Excerpt body={first?.body} value={value} />
            </li>
          );
        },
      }}
    />
  );
}

export function AccountCollections(props: Record<string, unknown>) {
  const readable = useOperation('collection.get');
  return (
    <AccountList
      props={props}
      spec={{
        slot: 'account-collections',
        view: 'collections',
        kind: 'accountCollections',
        title: (locale) => m.subject_collections({}, { locale: locale as never }),
        items: (body) => body.collections,
        row: (collection, value, index) => {
          const options = { locale: value.locale as never };
          const Link = value.link;
          const members = typeof collection.memberCount === 'number' ? collection.memberCount : undefined;
          return (
            <li key={typeof collection.id === 'string' ? collection.id : index} className="space-y-1">
              <p className="font-medium">
                <span className={`${linkClass} ${linkColor} [&_a]:underline!`}>
                  {readable ? (
                    <Link
                      href={`/${encodeURIComponent(value.locale)}/collections/${encodeURIComponent(String(collection.id))}`}
                    >
                      {typeof collection.title === 'string' && collection.title ? collection.title : value.unlabelled}
                    </Link>
                  ) : typeof collection.title === 'string' && collection.title ? (
                    collection.title
                  ) : (
                    value.unlabelled
                  )}
                </span>
                {members !== undefined && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {' · '}
                    {m.agent_collection_items({ count: members }, options)}
                  </span>
                )}
              </p>
              {typeof collection.description === 'string' && collection.description && (
                <p className="line-clamp-2 max-w-prose text-sm text-muted-foreground">{collection.description}</p>
              )}
            </li>
          );
        },
      }}
    />
  );
}
