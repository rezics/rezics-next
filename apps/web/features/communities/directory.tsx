import { buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { CompassIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react';
import { cookies } from 'next/headers';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { signInPath } from '../auth/paths.ts';
import { LinkMenu } from '../feed/controls.tsx';
import { RealmMembership } from '../realm/membership.tsx';
import { readMembership } from '../realm/membership-state.ts';
import type { RealmDirectoryPage } from '../realm/types.ts';
import { getMessages } from '../../i18n/server.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { CommunityIcon } from '../shell/community-icon.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { communityText as words } from './messages.ts';
import { DirectoryTopicFilter } from './topics.tsx';

type Sort = 'activity' | 'members' | 'newest';
type Search = Record<string, string | string[] | undefined>;
const sorts: Record<Sort, keyof typeof words> = { activity: 'active', members: 'popular', newest: 'new' };

export function directoryQuery(search: Search) {
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 80) : '';
  const sort: Sort = search.sort === 'members' || search.sort === 'newest' ? search.sort : 'activity';
  const cursor = typeof search.cursor === 'string' && search.cursor.length <= 2048 ? search.cursor : undefined;
  const topic = typeof search.topic === 'string' && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(search.topic)
    ? search.topic : undefined;
  return { q, sort, cursor, topic };
}

function href(q: string, sort: Sort, topic?: string, cursor?: string) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sort !== 'activity') params.set('sort', sort);
  if (topic) params.set('topic', topic);
  if (cursor) params.set('cursor', cursor);
  return `/r${params.size ? `?${params}` : ''}`;
}

async function directory(locale: UiLocale, q: string, sort: Sort, topic?: string, cursor?: string):
  Promise<{ ok: true; page: RealmDirectoryPage } | { ok: false }> {
  const main = mainApiWithToken(undefined);
  try {
    const call = () => main.v1.realms.get({ query: { language: locale, limit: 20, sort, ...(q ? { q } : {}),
      ...(topic ? { topic } : {}),
      ...(cursor ? { cursor } : {}) } });
    let result = await call();
    if (result.error?.status === 409 && !cursor) result = await call();
    return result.data ? { ok: true, page: result.data } : { ok: false };
  } catch { return { ok: false }; }
}

/** `/r`: a public directory. Membership controls read the same policy as a Realm header. */
export async function CommunityDirectory({ locale, search }: { locale: UiLocale; search: Search }) {
  const { q, sort, cursor, topic } = directoryQuery(search);
  const [result, jar, messages] = await Promise.all([directory(locale, q, sort, topic, cursor), cookies(),
    getMessages('realm', locale)]);
  const token = jar.get(ACCESS_COOKIE)?.value;
  const agent = token ? await sessionAgentState() : null;
  const actingSubject = agent?.sessionAgent.eligible ? agent.sessionAgent.actingSubject : null;
  const memberMain = mainApiWithToken(actingSubject ? token : undefined);
  const memberships = result.ok && actingSubject
    ? await Promise.all(result.page.items.map(item => readMembership(memberMain, item.id, actingSubject)
      .catch(() => null))) : [];
  return <PageContainer className="grid gap-7">
    <PageHeader title={words.title[locale]} description={words.intro[locale]} actions={<Link href="/r/new"
      className={buttonVariants({ pill: true })}><PlusIcon aria-hidden="true" />{words.create[locale]}</Link>} />
    <div className="flex flex-wrap items-end gap-3">
      <form action={localizedPath('/r', locale)} className="flex min-w-0 flex-1 gap-2 sm:max-w-xl">
        {sort !== 'activity' ? <input type="hidden" name="sort" value={sort} /> : null}
        {topic ? <input type="hidden" name="topic" value={topic} /> : null}
        <label className="min-w-0 flex-1 space-y-1 text-sm font-medium">
          <span className="sr-only">{words.search[locale]}</span>
          <Input type="search" name="q" defaultValue={q} maxLength={80} placeholder={words.search[locale]} />
        </label>
        <button type="submit" className={buttonVariants({ variant: 'outline' })}>
          <SearchIcon aria-hidden="true" className="size-4" />{words.searchAction[locale]}</button>
      </form>
      <LinkMenu label={words.sort[locale]} value={sort} options={Object.entries(sorts).map(([value, label]) =>
        ({ value, label: words[label][locale], href: href(q, value as Sort, topic) }))} />
    </div>
    <DirectoryTopicFilter locale={locale} q={q} sort={sort} selected={result.ok && result.page.topic
      ? { id: result.page.topic.id, label: result.page.topic.label.value } : null} />
    {!result.ok ? <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert"
      title={words.unavailable[locale]} description={words.unavailableBody[locale]}>
      <Link href={href(q, sort, topic)} className={buttonVariants({ variant: 'outline' })}>
        {words.first[locale]}</Link>
    </EmptyState> : result.page.items.length ? <>
      <ul className="grid gap-3 sm:grid-cols-2">
        {result.page.items.map((item, index) => {
          const path = `/r/${item.id.slice(-36)}`;
          return <li key={item.id} className="flex min-w-0 items-start gap-3 rounded-2xl border border-border/80
            bg-card p-4 shadow-xs">
            <Link href={path} aria-label={item.name.value} className="rounded-full outline-none
              focus-visible:ring-2 focus-visible:ring-ring">
              <CommunityIcon icon={item.icon} name={item.name.value} size="md" /></Link>
            <div className="grid min-w-0 flex-1 gap-1">
              <Link href={path} lang={item.name.language} className="truncate font-semibold underline-offset-2
                hover:underline">{item.name.value}</Link>
              {item.description ? <p lang={item.description.language} className="line-clamp-2 text-muted-foreground
                text-sm">{item.description.value}</p> : null}
              <p className="text-muted-foreground text-xs">
                {item.membership.count.kind !== 'unknown' ? <span>
                  {new Intl.NumberFormat(locale).format(item.membership.count.value)} {words.members[locale]}</span> : null}
                {item.reviewMode === 'mandatory' ? <span className="ms-2">{words.review[locale]}</span> : null}
              </p>
            </div>
            <RealmMembership realm={item.id} realmName={item.name.value} initial={memberships[index] ?? null}
              signedIn={Boolean(token)} actingSubject={actingSubject}
              signInHref={signInPath(localizedPath(path, locale))}
              rulesHref={`${path}/about`} locale={locale} messages={messages} />
          </li>;
        })}
      </ul>
      {cursor || result.page.nextCursor ? <nav aria-label={words.title[locale]}
        className="flex justify-between gap-3">
        {cursor ? <Link href={href(q, sort, topic)} className={buttonVariants({ variant: 'outline' })}>
          {words.first[locale]}</Link> : <span />}
        {result.page.nextCursor ? <Link href={href(q, sort, topic, result.page.nextCursor)} rel="next"
          className={buttonVariants({ variant: 'outline' })}>{words.next[locale]}</Link> : null}
      </nav> : null}
    </> : <EmptyState icon={CompassIcon} title={words.empty[locale]} description={words.emptyBody[locale]}>
      <Link href="/r/new" className={buttonVariants()}>{words.create[locale]}</Link>
    </EmptyState>}
  </PageContainer>;
}
