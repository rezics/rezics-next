import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ZoneDecision, ZoneWork } from '@rezics/zone-sdk';
import { ArrowLeftIcon, ArrowRightIcon, BookOpenTextIcon, GavelIcon, LandmarkIcon, MessagesSquareIcon,
  PlusIcon, RotateCwIcon, ScaleIcon, ShieldIcon, TagIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { slotRatio } from '../catalogue/work.ts';
import { workTitle, ZoneWorkCard, ZoneWorkRow } from '../zones/card.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { ModuleHeading } from '../zones/module-frame.tsx';
import { decisionText } from '../zones/modules.tsx';
import type { RealmMessages } from './messages.ts';
import { decisionAnchor } from './route.ts';
import type { ReadFailure } from './types.ts';

/** A tab's heading block: the view's title and one line on what it lists. */
function ViewHeader({ id, title, intro, children }: { id: string; title: string; intro?: string; children?: ReactNode }) {
  return <header className="flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0 space-y-1">
      <ModuleHeading id={id} className="text-[length:calc(1.375rem*var(--zone-heading-scale,1))]">{title}</ModuleHeading>
      {intro ? <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{intro}</p> : null}
    </div>
    {children}
  </header>;
}

/** A tab's list failed or moved under its cursor; the frame stays. */
export function ListFailure({ failure, firstPage, messages }: {
  failure: ReadFailure; firstPage: string; messages: RealmMessages;
}) {
  const moved = failure === 'moved';
  return <EmptyState icon={moved ? RotateCwIcon : TriangleAlertIcon} role="status"
    title={moved ? messages.movedTitle : messages.failedTitle}
    description={moved ? messages.movedBody : messages.unavailableBody}>
    <LocalizedLink href={firstPage} className={buttonVariants({ variant: moved ? 'default' : 'outline' })}>
      {moved ? messages.startOver : messages.retry}</LocalizedLink>
  </EmptyState>;
}

/** Cursor paging as links, so every page has its own URL. */
function Pager({ next, first, messages }: { next: string | null; first: string | null; messages: RealmMessages }) {
  if (!next && !first) return null;
  return <nav className="flex flex-wrap justify-center gap-2">
    {first ? <LocalizedLink href={first} className={buttonVariants({ variant: 'ghost' })}>
      <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{messages.firstPage}</LocalizedLink> : null}
    {next ? <LocalizedLink href={next} className={buttonVariants({ variant: 'outline' })}>
      {messages.showMore}<ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></LocalizedLink> : null}
  </nav>;
}

/** The Works tab: every Work the Realm adopted, covers first, a page at a time. */
export function RealmWorks({ realmName, works, next, first, locale, messages, zoneMessages, avatarQuery }: {
  realmName: string; works: readonly ZoneWork[]; next: string | null; first: string | null;
  locale: UiLocale; messages: RealmMessages; zoneMessages: ZoneMessages; avatarQuery?: string;
}) {
  const slot = slotRatio(works);
  const t = materializeData(messages, { locale });
  return <PageContainer className="grid grid-cols-1 gap-6">
    <section aria-labelledby="realm-works" className="grid grid-cols-1 gap-5 rounded-(--zone-radius-card) bg-(--zone-panel)
      p-(--zone-panel-pad)">
      <ViewHeader id="realm-works" title={t.worksTitle({ realm: realmName })} intro={messages.worksIntro}>
        {works.length ? <p className="text-muted-foreground text-sm">{t.worksCount(works.length)}</p> : null}
      </ViewHeader>
      {works.length ? <ul className="grid grid-cols-2 gap-x-(--zone-shelf-gap) gap-y-8 sm:grid-cols-3 md:grid-cols-4
        lg:grid-cols-5">
        {works.map(work => <li key={work.id} className="min-w-0">
          <ZoneWorkCard work={work} slot={slot} locale={locale} messages={zoneMessages} avatarQuery={avatarQuery} />
        </li>)}
      </ul> : <EmptyState icon={BookOpenTextIcon} title={messages.worksEmpty} description={messages.worksEmptyBody}
        headingLevel={3} />}
    </section>
    <Pager next={next} first={first} messages={messages} />
  </PageContainer>;
}

const kindIcons = { adoption: PlusIcon, classification: TagIcon, 'semantic-rule-change': ScaleIcon } as const;

/** The Decisions tab: the public curation log. Each entry is the target of the "Why here?" links. */
export function RealmDecisions({ decisions, next, first, locale, messages, zoneMessages }: {
  decisions: readonly ZoneDecision[]; next: string | null; first: string | null;
  locale: UiLocale; messages: RealmMessages; zoneMessages: ZoneMessages;
}) {
  const kinds = { adoption: messages.adoption, classification: messages.classification,
    'semantic-rule-change': messages.ruleChange } as const;
  return <PageContainer className="grid grid-cols-1 gap-6">
    <section aria-labelledby="realm-decisions" className="grid grid-cols-1 gap-5 rounded-(--zone-radius-card) bg-(--zone-panel)
      p-(--zone-panel-pad)">
      <ViewHeader id="realm-decisions" title={messages.decisionsTitle} intro={messages.decisionsIntro} />
      {decisions.length ? <ol className="grid grid-cols-1">
        {decisions.map(decision => {
          const Icon = decision.outcome === 'rejected' ? XIcon : kindIcons[decision.kind];
          return <li key={decision.id} id={decisionAnchor(decision.id)} className="group scroll-mt-32 border-border/60
            border-b py-3.5 last:border-b-0 target:rounded-xl target:border-transparent target:bg-accent target:px-3">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-accent
                text-accent-foreground group-target:bg-primary group-target:text-primary-foreground">
                <Icon className="size-4" /></span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">{decisionText(decision, locale, zoneMessages)}</p>
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <Badge variant="outline">{kinds[decision.kind]}</Badge>
                  {decision.outcome ? <Badge variant={decision.outcome === 'accepted' ? 'success' : 'outline'}>
                    {decision.outcome === 'accepted' ? messages.accepted : messages.rejected}</Badge> : null}
                  <span className="hidden font-medium text-primary group-target:inline">{messages.decisionLinked}</span>
                </div>
              </div>
              {decision.work ? <LocalizedLink href={decision.work.href} className={cn(buttonVariants({ variant: 'ghost',
                size: 'sm' }), 'shrink-0')}>
                <span className="max-sm:sr-only">{messages.openWork}</span>
                <ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></LocalizedLink> : null}
            </div>
          </li>;
        })}
      </ol> : <EmptyState icon={GavelIcon} title={messages.decisionsEmpty} description={messages.decisionsEmptyBody}
        headingLevel={3} />}
    </section>
    <Pager next={next} first={first} messages={messages} />
  </PageContainer>;
}

/** The Discussions tab: conversations live on each Work, read in this Realm's scope. */
export function RealmDiscussions({ works, locale, messages, zoneMessages, avatarQuery }: {
  works: readonly ZoneWork[]; locale: UiLocale; messages: RealmMessages; zoneMessages: ZoneMessages;
  avatarQuery?: string;
}) {
  return <PageContainer className="grid grid-cols-1 gap-6">
    <section aria-labelledby="realm-discussions" className="grid grid-cols-1 gap-5 rounded-(--zone-radius-card) bg-(--zone-panel)
      p-(--zone-panel-pad)">
      <ViewHeader id="realm-discussions" title={messages.discussionsTitle} intro={messages.discussionsIntro} />
      {works.length ? <ul className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {works.map(work => <li key={work.id} className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1"><ZoneWorkRow work={work} locale={locale} messages={zoneMessages}
            avatarQuery={avatarQuery} /></div>
          <LocalizedLink href={discussionHref(work)} aria-label={`${messages.openDiscussion}: ${workTitle(work,
            zoneMessages)}`} className={cn(buttonVariants({ variant: 'outline', size: 'sm', pill: true }),
            'relative z-10 shrink-0')}>
            <MessagesSquareIcon aria-hidden="true" /><span className="max-sm:sr-only">{messages.openDiscussion}</span>
          </LocalizedLink>
        </li>)}
      </ul> : <EmptyState icon={MessagesSquareIcon} title={messages.worksEmpty} description={messages.worksEmptyBody}
        headingLevel={3} />}
    </section>
  </PageContainer>;
}

/** A Work's discussion tab in the same Realm scope as the card's Work link. */
function discussionHref(work: ZoneWork): string {
  const [path, query] = work.href.split('?');
  return `${path}/discussion${query ? `?${query}` : ''}`;
}

export interface AboutRule { id: string; title: string; body: string; governed: boolean; lang: string }

/** The About tab: what the community is, its rules and who moderates it. */
export function RealmAbout({ realmName, description, rules, moderators, members, others, locale, messages }: {
  realmName: string; description: { value: string; lang: string } | null; rules: readonly AboutRule[] | null;
  /** Null when the Realm does not publish its moderators. */
  moderators: number | null; members: string | null;
  /** Other communities to look at, from the Realm directory. */
  others: readonly { href: string; name: { value: string; lang: string }; members: string | null }[];
  locale: UiLocale; messages: RealmMessages;
}) {
  const t = materializeData(messages, { locale });
  return <PageContainer className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18.5rem] lg:items-start">
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <section aria-labelledby="realm-about" className="grid grid-cols-1 gap-3 rounded-(--zone-radius-card) bg-(--zone-panel)
        p-(--zone-panel-pad)">
        <ModuleHeading id="realm-about">{t.aboutTitle({ realm: realmName })}</ModuleHeading>
        {description ? <p lang={description.lang} className="max-w-2xl whitespace-pre-line text-pretty leading-relaxed">
          {description.value}</p> : null}
        {members ? <p className="text-muted-foreground text-sm">{members}</p> : null}
      </section>
      <section aria-labelledby="realm-rules" className="grid grid-cols-1 gap-3 rounded-(--zone-radius-card) bg-(--zone-panel)
        p-(--zone-panel-pad)">
        <ModuleHeading id="realm-rules">{messages.rules}</ModuleHeading>
        {rules?.length ? <ol className="grid grid-cols-1 gap-3">
          {rules.map((rule, index) => <li key={rule.id} lang={rule.lang} className="grid grid-cols-[auto_1fr] gap-x-3
            gap-y-1 rounded-xl bg-muted/50 p-4">
            <span aria-hidden="true" className="row-span-2 grid size-7 place-items-center rounded-full bg-primary
              font-semibold text-primary-foreground text-sm tabular-nums">{index + 1}</span>
            <h3 className="font-medium"><span className="sr-only">{t.rule({ number: String(index + 1) })}: </span>
              {rule.title}</h3>
            <div className="grid grid-cols-1 gap-2">
              <p className="whitespace-pre-line text-pretty text-muted-foreground text-sm leading-relaxed">{rule.body}</p>
              {rule.governed ? <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <LandmarkIcon aria-hidden="true" className="size-3.5" />{messages.governed}</p> : null}
            </div>
          </li>)}
        </ol> : <p className="text-muted-foreground">{messages.noRules}</p>}
      </section>
    </div>
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <section aria-labelledby="realm-moderators" className="grid grid-cols-1 gap-2 rounded-(--zone-radius-card) bg-(--zone-panel)
        p-(--zone-panel-pad)">
        <ModuleHeading id="realm-moderators">{messages.moderators}</ModuleHeading>
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <ShieldIcon aria-hidden="true" className="size-4" />
          {moderators === null ? messages.moderatorsHidden : t.moderatorCount(moderators)}</p>
      </section>
      {others.length ? <nav aria-labelledby="realm-others" className="grid grid-cols-1 gap-2 rounded-(--zone-radius-card)
        bg-(--zone-panel) p-(--zone-panel-pad)">
        <ModuleHeading id="realm-others">{messages.otherCommunities}</ModuleHeading>
        <ul className="grid grid-cols-1">
          {others.map(other => <li key={other.href}>
            <LocalizedLink href={other.href} className="flex flex-col rounded-lg px-2 py-2 outline-none hover:bg-accent/60
              focus-visible:ring-2 focus-visible:ring-ring">
              <span lang={other.name.lang} className="truncate font-medium text-sm">{other.name.value}</span>
              {other.members ? <span className="text-muted-foreground text-xs">{other.members}</span> : null}
            </LocalizedLink></li>)}
        </ul>
      </nav> : null}
    </div>
  </PageContainer>;
}
