import { direction } from '@rezics/main/language';
import { ChevronDownIcon, ScrollTextIcon, UsersRoundIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';

/** A discussion page's columns: the posts, and the community rail beside them (below them on phones). */
export function DiscussionColumns({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return <PageContainer className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8">
    <div className="min-w-0">{children}</div>{rail}
  </PageContainer>;
}

export interface RailRule { id: string; title: string; body: string; lang: string }

/**
 * A community's side rail beside its discussions, as a subreddit keeps one:
 * what the Realm is for and its rules, each rule opening to its full text.
 * Below the thread on phones, where the rail cannot sit beside it.
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
    <section aria-labelledby="rail-about" className={card}>
      <h2 id="rail-about" className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        {labels.about}</h2>
      <p lang={name.lang} dir={direction(name.lang, name.value)} className="font-semibold">{name.value}</p>
      {description ? <p lang={description.lang} dir={direction(description.lang, description.value)}
        className="text-pretty text-muted-foreground text-sm/relaxed">
        {description.value}</p> : null}
      {members ? <p className="flex items-center gap-1.5 text-sm"><UsersRoundIcon aria-hidden="true"
        className="size-4 text-muted-foreground" />{members}</p> : null}
      <LocalizedLink href={aboutHref} className="w-fit font-medium text-primary text-sm underline-offset-4
        hover:underline">{labels.more}</LocalizedLink>
    </section>
    {rules.length ? <section aria-labelledby="rail-rules" className={card}>
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
