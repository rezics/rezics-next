import { useOperation } from '../../kernel/exposure';
import { Cover } from '@rezics/ui/cover';
import { ContentItem } from '@rezics/ui/content-item';
import { useId, useSyncExternalStore, type SyntheticEvent } from 'react';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { accountOf } from './account-profile-reading';
import { accountOperationAllowed, readAccountViewerActions } from './account-read';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { browserObservation } from '../../session/observation';
import { useSession } from '../../session/query';
import type { OverviewValue } from './overview';
import { useOverview } from './overview-section';
import { PublicAccountState } from '../../accounts/public-profile/view';
import { AccountList } from './account-page-application';
import { linkClass, linkColor, webUrl } from './shared';
import { ContributionReturnRecovery, ContributionRow } from '../../accounts/public-profile/contributions/row';
import { subjectHref } from '../../subject/load-subject';
import { AccountFollow } from '../../accounts/public-profile/follow';
/** Private controls start after hydration and disappear throughout every refresh. */
function AccountManagementLinks({ id, value }: { id: string; value: OverviewValue }) {
  const session = useSession();
  const client = useQueryClient();
  const reader = browserObservation(client);
  const mount = useId();
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getServerSnapshot);
  const observation = snapshot.state === 'signed-in' ? snapshot.observation : undefined;
  const enabled =
    personalRead.enabled &&
    session.state === 'signed-in' &&
    !!session.subject &&
    observation?.subject === session.subject;
  const currentReader = () => enabled && reader.getSnapshot() === snapshot;
  const queryKey = ['account-viewer-actions', id, session.subject, session.csrfToken, mount, observation?.id];
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled,
    queryFn: () => readAccountViewerActions({ data: id }),
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  if (!currentReader() || query.isPending || query.fetchStatus !== 'idle') return null;
  const options = { locale: value.locale as never };
  if (query.isError || query.data?.state === 'unavailable')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.settings_unavailable_title({}, options)}{' '}
        <button
          type="button"
          className={linkClass}
          onClick={() => {
            if (currentReader()) void query.refetch();
          }}
        >
          {m.settings_retry({}, options)}
        </button>
      </p>
    );
  const allowed = (action: string, operation: string) => accountOperationAllowed(query.data, action, operation);
  const profile = ['account:update', 'account:manage'].some(
    (action) => allowed(action, 'account.update') && allowed(action, 'account.read_editable_profile'),
  );
  const settings =
    allowed('account:read', 'account.read_preferences') && allowed('account:update', 'account.set_preferences');
  const verification = ['account:read', 'account:manage'].some((action) =>
    allowed(action, 'account.read_verification_request'),
  );
  const prefix = `/${encodeURIComponent(value.locale)}`;
  const securityHref = settings && query.data?.state === 'ready' ? query.data.securityHref : null;
  if (!profile && !settings && !verification) return null;
  const guardNavigation = (event: SyntheticEvent) => {
    // A retained link cannot dispatch between a cache publication and React's render.
    const permissions = client.getQueryState(queryKey);
    if (
      !currentReader() ||
      permissions?.status !== 'success' ||
      permissions.fetchStatus !== 'idle' ||
      permissions.isInvalidated ||
      permissions.data !== query.data
    )
      event.preventDefault();
  };
  return (
    <nav
      aria-label={m.av_accounts({}, options)}
      data-slot="account-management-links"
      className="flex flex-wrap gap-x-4 gap-y-2 text-sm"
      onClickCapture={guardNavigation}
      onAuxClickCapture={guardNavigation}
    >
      {settings && <value.link href={`${prefix}/settings`}>{m.settings_heading({}, options)}</value.link>}
      {profile && <value.link href={`${prefix}/accounts`}>{m.av_accounts({}, options)}</value.link>}
      {verification && (
        <value.link href={`${prefix}/accounts/${encodeURIComponent(id)}/verification`}>
          {m.av_application({}, options)}
        </value.link>
      )}
      {securityHref && (
        <a href={securityHref} className={linkClass}>
          {m.account_security_settings({}, options)}
        </a>
      )}
    </nav>
  );
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
      <div
        data-slot="agent-header"
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-6"
      >
        <div className="sm:row-span-2">
          <div className="sm:hidden">{avatar('sm')}</div>
          <div className="hidden w-40 sm:block">{avatar('md')}</div>
        </div>
        <div className="min-w-0 flex-1 space-y-2 in-data-[density=compact]:space-y-1.5">
          <h1 className="min-w-0 font-sans text-3xl font-semibold tracking-tight wrap-anywhere text-balance sm:text-4xl in-data-[heading-scale=lg]:sm:text-5xl">
            {name}
          </h1>
          {profile.handle && (
            <p data-slot="agent-handle" className="text-sm wrap-anywhere text-muted-foreground">
              {`@${profile.handle}`}
            </p>
          )}
          <p data-slot="agent-kind" className="text-sm text-muted-foreground">
            {profile.kind === 'organization'
              ? m.settings_verification_organization({}, { locale: value.locale as never })
              : m.settings_verification_person({}, { locale: value.locale as never })}
          </p>
        </div>
        <div
          data-slot="agent-description"
          className="col-span-full min-w-0 space-y-3 wrap-anywhere sm:col-span-1 sm:col-start-2"
        >
          {profile.bio && <p className="max-w-prose leading-7 text-pretty whitespace-pre-line">{profile.bio}</p>}
          {value.subject ? <AccountFollow targetId={value.subject} /> : null}
          <AccountManagementLinks key={profile.id} id={profile.id} value={value} />
          {profile.verified && profile.subject && (
            <p className="text-sm" data-slot="agent-verified">
              <value.link
                href={subjectHref({ id: profile.subject.id, label: profile.subject.label }, value.locale).href}
              >
                {m.public_account_verified({ name: profile.subject.label }, { locale: value.locale as never })}
              </value.link>
            </p>
          )}
          {profile.automated && (
            <p data-slot="agent-automation" className="text-sm font-medium">
              {m.public_account_automated({}, { locale: value.locale as never })}
            </p>
          )}
          {profile.operated && (
            <p data-slot="agent-operator" className="text-sm text-muted-foreground">
              {m.agent_operated_by({}, { locale: value.locale as never })}{' '}
              {value.operator?.handle ? (
                <value.link href={`/${encodeURIComponent(value.locale)}/@${encodeURIComponent(value.operator.handle)}`}>
                  {value.operator.displayName || value.operator.handle}
                </value.link>
              ) : (
                <span>
                  {value.operator?.displayName ||
                    m.public_account_operator_unavailable({}, { locale: value.locale as never })}
                </span>
              )}
            </p>
          )}
          {links.length > 0 && (
            <ul
              aria-label={m.agent_links({}, { locale: value.locale as never })}
              className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm"
            >
              {links.map((link) => (
                <li key={link.url} className="min-w-0 max-w-full">
                  <a
                    className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center font-medium`}
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

export function AccountPosts(props: Record<string, unknown>) {
  return (
    <AccountList
      props={props}
      spec={{
        failure: (state) => <PublicAccountState state={state} />,
        slot: 'account-posts',
        view: 'posts',
        kind: 'accountPosts',
        recovery: (rows, locale) => <ContributionReturnRecovery rows={rows} locale={locale} />,
        title: (locale) => m.subject_posts({}, { locale: locale as never }),
        items: (body) => body.posts,
        row: (post, value, index) => (
          <ContributionRow key={typeof post.id === 'string' ? post.id : index} item={post} kind="reply" value={value} />
        ),
      }}
    />
  );
}

export function AccountThreads(props: Record<string, unknown>) {
  return (
    <AccountList
      props={props}
      spec={{
        failure: (state) => <PublicAccountState state={state} />,
        slot: props.threadKind === 'review' ? 'account-reviews' : 'account-threads',
        view: props.threadKind === 'review' ? 'reviews' : 'discussion',
        kind: 'accountThreads',
        recovery: (rows, locale) => <ContributionReturnRecovery rows={rows} locale={locale} />,
        title: (locale) =>
          props.threadKind === 'review'
            ? m.subject_reviews({}, { locale: locale as never })
            : m.subject_discussion({}, { locale: locale as never }),
        items: (body) => body.threads,
        row: (thread, value, index) => (
          <ContributionRow
            key={typeof thread.id === 'string' ? thread.id : index}
            item={thread}
            kind={props.threadKind === 'review' ? 'review' : 'discussion'}
            value={value}
          />
        ),
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
        failure: (state) => <PublicAccountState state={state} />,
        slot: 'account-collections',
        view: 'collections',
        kind: 'accountCollections',
        title: (locale) => m.subject_collections({}, { locale: locale as never }),
        items: (body) => body.collections,
        row: (collection, value, index) => {
          const options = { locale: value.locale as never };
          const members = typeof collection.memberCount === 'number' ? collection.memberCount : undefined;
          const title = typeof collection.title === 'string' && collection.title ? collection.title : value.unlabelled;
          const href = `/${encodeURIComponent(value.locale)}/collections/${encodeURIComponent(String(collection.id))}`;
          return (
            <ContentItem
              key={typeof collection.id === 'string' ? collection.id : index}
              title={title}
              {...(readable ? { href } : {})}
              headingLevel={3}
              metadata={
                members !== undefined ? (
                  <span className="text-sm font-normal text-muted-foreground">
                    {m.agent_collection_items({ count: members }, options)}
                  </span>
                ) : null
              }
              preview={
                typeof collection.description === 'string' && collection.description ? (
                  <p className="line-clamp-2 max-w-prose text-sm text-muted-foreground">{collection.description}</p>
                ) : null
              }
            />
          );
        },
      }}
    />
  );
}
