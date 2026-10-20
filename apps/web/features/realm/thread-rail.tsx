import { direction } from '@rezics/main/language';
import { ChevronDownIcon, ScrollTextIcon, UsersRoundIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';

/** Community information precedes the posts on phones and sits beside them on desktop. */
export function DiscussionColumns({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return <PageContainer className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8">
    <div className="min-w-0 lg:col-start-2 lg:row-start-1">{rail}</div>
    <div className="min-w-0 lg:col-start-1 lg:row-start-1">{children}</div>
  </PageContainer>;
}

export interface RailRule { id: string; title: string; body: string; lang: string }

/** A thread keeps the community address and membership controls without repeating its landing page. */
export function CommunityContext({ name, href, actions }: {
  name: { value: string; lang: string; dir: 'ltr' | 'rtl' }; href: string; actions: ReactNode;
}) {
  return <PageContainer className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3 sm:py-3 lg:py-3">
    <LocalizedLink href={href} lang={name.lang} dir={name.dir}
      className="min-w-0 font-semibold text-sm underline-offset-4 [overflow-wrap:anywhere] hover:underline">
      {name.value}</LocalizedLink>
    <div className="flex flex-wrap items-center gap-2">{actions}</div>
  </PageContainer>;
}

/**
 * A community's side rail beside its discussions, as a subreddit keeps one:
 * what the Realm is for and its rules, each rule opening to its full text.
 * On phones, compact links keep the full community information and rules reachable before replying.
 */
export function ThreadRail({ name, description, members, aboutHref, rules, labels }: {
  name: { value: string; lang: string };
  description: { value: string; lang: string } | null;
  members: string | null;
  aboutHref: string;
  rules: readonly RailRule[];
  labels: { about: string; rules: string; more: string };
}) {
  const card = 'grid gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-(--aura-shadow-card)';
  return <aside aria-label={labels.about} className="grid content-start gap-4 lg:sticky lg:top-20">
    <nav aria-label={labels.about} className="flex flex-wrap gap-x-4 gap-y-1 text-sm lg:hidden">
      <LocalizedLink href={aboutHref} className="inline-flex min-h-9 items-center rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{labels.more}</LocalizedLink>
      {rules.length ? <LocalizedLink href={`${aboutHref}#realm-rules`} className="inline-flex min-h-9 items-center gap-1.5 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        <ScrollTextIcon aria-hidden="true" className="size-4" />{labels.rules}</LocalizedLink> : null}
    </nav>
    <section aria-labelledby="rail-about" className={`${card} hidden lg:grid`}>
      <h2 id="rail-about" className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        {labels.about}</h2>
      <p lang={name.lang} dir={direction(name.lang, name.value)} className="font-semibold">{name.value}</p>
      {description ? <p lang={description.lang} dir={direction(description.lang, description.value)}
        className="line-clamp-5 text-pretty text-muted-foreground text-sm/relaxed">
        {description.value}</p> : null}
      {members ? <p className="flex items-center gap-1.5 text-sm"><UsersRoundIcon aria-hidden="true"
        className="size-4 text-muted-foreground" />{members}</p> : null}
      <LocalizedLink href={aboutHref} className="inline-flex min-h-8 w-fit items-center font-medium text-primary text-sm
        underline-offset-4 hover:underline">{labels.more}</LocalizedLink>
    </section>
    {rules.length ? <section aria-labelledby="rail-rules" className={`${card} hidden lg:grid`}>
      <h2 id="rail-rules" className="flex items-center gap-1.5 font-semibold text-muted-foreground text-xs uppercase
        tracking-wide"><ScrollTextIcon aria-hidden="true" className="size-3.5" />{labels.rules}</h2>
      <ol className="grid divide-y divide-border/60">
        {rules.map((rule, index) => <li key={rule.id} lang={rule.lang} dir={direction(rule.lang, rule.title)}>
          <details className="group/rule py-2">
            <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md text-sm outline-none
              focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span className="w-4 shrink-0 text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 font-medium">{rule.title}</span>
              <ChevronDownIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground
                transition-transform group-open/rule:rotate-180" />
            </summary>
            <p className="ps-6 pt-1.5 text-pretty text-muted-foreground text-sm/relaxed">{rule.body}</p>
          </details>
        </li>)}
      </ol>
    </section> : null}
  </aside>;
}
