import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ZoneDecision } from '@rezics/zone-sdk';
import { ArrowLeftIcon, ArrowRightIcon, GavelIcon, LandmarkIcon, PlusIcon, RotateCwIcon, ScaleIcon, SearchXIcon,
  ShieldIcon, TagIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { direction } from '@rezics/main/language';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { signInPath } from '../auth/paths.ts';
import { browseMessages } from '../discover/browse-messages.ts';
import { isolate } from '../language/untagged.ts';
import { ProfileAvatar } from '../profile/profile-avatar.tsx';
import { failureText, type ReadFailure } from '../feed/types.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { ModuleHeading } from '../zones/module-frame.tsx';
import { decisionText } from '../zones/modules.tsx';
import type { RealmMessages } from './messages.ts';
import { decisionAnchor } from './route.ts';
import { LinkedDecision } from './linked-decision.tsx';

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

/** A tab's list failed or moved under its cursor; the frame stays. A closed read is absent. */
export function ListFailure({ failure, reference, firstPage, messages }: {
  failure: ReadFailure; reference?: string; firstPage: string; messages: RealmMessages;
}) {
  const text = failureText(failure, { failedTitle: messages.failedTitle, offline: messages.offlineBody,
    server: messages.unavailableBody, missingTitle: messages.notFoundTitle, missingBody: messages.notFoundBody,
    deniedTitle: messages.deniedTitle, deniedBody: messages.deniedBody, movedTitle: messages.movedTitle,
    movedBody: messages.movedBody, budget: messages.budgetBody });
  if (text.kind === 'absent') return null;
  const moved = text.action === 'restart';
  const quiet = text.action === 'none' || text.action === 'sign-in';
  return <EmptyState icon={moved ? RotateCwIcon : quiet ? SearchXIcon : TriangleAlertIcon}
    role={quiet || moved ? 'status' : 'alert'} tone={quiet || moved ? 'default' : 'destructive'}
    title={text.title} description={failureDetail(text.description, reference, messages.errorReference, text.reference)}>
    {text.action === 'none' ? null : text.action === 'sign-in'
      ? <LocalizedLink href={signInPath(firstPage)} className={buttonVariants()}>{messages.signIn}</LocalizedLink>
      : <LocalizedLink href={firstPage} className={buttonVariants({ variant: moved ? 'default' : 'outline' })}>
        {moved ? messages.startOver : messages.retry}</LocalizedLink>}
  </EmptyState>;
}

/** Cursor paging as links, so every page has its own URL. */
export function Pager({ next, first, messages }: { next: string | null; first: string | null; messages: RealmMessages }) {
  if (!next && !first) return null;
  return <nav className="flex flex-wrap justify-center gap-2">
    {first ? <LocalizedLink href={first} className={buttonVariants({ variant: 'ghost' })}>
      <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{messages.firstPage}</LocalizedLink> : null}
    {next ? <LocalizedLink href={next} className={buttonVariants({ variant: 'outline' })}>
      {messages.showMore}<ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></LocalizedLink> : null}
  </nav>;
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
      <LinkedDecision listId="realm-decision-list" />
      {decisions.length ? <ol id="realm-decision-list" className="grid grid-cols-1">
        {decisions.map(decision => {
          const Icon = decision.outcome === 'rejected' ? XIcon : kindIcons[decision.kind];
          return <li key={decision.id} id={decisionAnchor(decision.id)} className="group scroll-mt-32 border-border/60
            border-b py-3.5 last:border-b-0 data-linked:rounded-xl data-linked:border-transparent data-linked:bg-accent
            data-linked:px-3">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-accent
                text-accent-foreground group-data-linked:bg-primary group-data-linked:text-primary-foreground">
                <Icon className="size-4" /></span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">{decisionText(decision, locale, zoneMessages)}</p>
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <Badge variant="outline">{kinds[decision.kind]}</Badge>
                  {decision.outcome ? <Badge variant={decision.outcome === 'accepted' ? 'success' : 'outline'}>
                    {decision.outcome === 'accepted' ? messages.accepted : messages.rejected}</Badge> : null}
                  <span className="hidden font-medium text-primary group-data-linked:inline">{messages.decisionLinked}</span>
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
export interface AboutRule { id: string; title: string; body: string; governed: boolean; lang: string }

/** Someone the About tab names: a moderator, or a member who chose to be listed. */
export interface AboutPerson {
  id: string; name: string;
  /** Their profile, when they have a handle. */
  href: string | null;
  kind: 'person' | 'organization' | 'service';
  avatarUrl: string | null;
  featured?: boolean;
}

function PersonRow({ person, note }: { person: AboutPerson; note?: string }) {
  const body = <>
    <ProfileAvatar name={person.name} kind={person.kind} avatarUrl={person.avatarUrl} size="sm" className="size-9 text-sm" />
    <span className="min-w-0">
      <span className="block truncate font-medium text-sm">{person.name}</span>
      {note ? <span className="block truncate text-muted-foreground text-xs">{note}</span> : null}
    </span>
  </>;
  return person.href ? <LocalizedLink href={person.href} className="flex items-center gap-3 rounded-lg p-1.5 outline-none
    hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">{body}</LocalizedLink>
    : <div className="flex items-center gap-3 p-1.5">{body}</div>;
}

/** The About tab: what the community is, its rules and the people who run it. */
export function RealmAbout({ realmName, description, rules, moderators, members, listed, others, locale, messages, only, children }: {
  realmName: string; description: { value: string; lang: string } | null; rules: readonly AboutRule[] | null;
  /** Null when the Realm does not publish its moderators. */
  moderators: readonly AboutPerson[] | null; members: string | null;
  /** Members who chose to be listed; null when the roster is not public. */
  listed: { people: readonly AboutPerson[]; more: boolean } | null;
  /** Other communities to look at, from the Realm directory. */
  others: readonly { href: string; name: { value: string; lang: string }; members: string | null }[];
  locale: UiLocale; messages: RealmMessages;
  /** Dedicated fixed community routes reuse these sections without repeating the About page. */
  only?: 'rules' | 'members'; children?: ReactNode;
}) {
  const t = materializeData(messages, { locale });
  return <PageContainer className={cn('grid grid-cols-1 gap-6', !only && 'lg:grid-cols-[minmax(0,1fr)_18.5rem] lg:items-start')}>
    {only !== 'members' ? <div className="grid min-w-0 grid-cols-1 gap-6">
      {!only ? <section aria-labelledby="realm-about" className="grid grid-cols-1 gap-3 rounded-(--zone-radius-card) bg-(--zone-panel)
        p-(--zone-panel-pad)">
        <ModuleHeading id="realm-about">{t.aboutTitle({ realm: isolate(realmName) })}</ModuleHeading>
        {description ? <p lang={description.lang} dir={direction(description.lang, description.value)}
          className="max-w-2xl whitespace-pre-line text-pretty leading-relaxed">
          {description.value}</p> : null}
        {members ? <p className="text-muted-foreground text-sm">{members}</p> : null}
      </section> : null}
      <section aria-labelledby="realm-rules" className="grid grid-cols-1 gap-3 rounded-(--zone-radius-card) bg-(--zone-panel)
        p-(--zone-panel-pad)">
        <ModuleHeading id="realm-rules">{messages.rules}</ModuleHeading>
        {rules?.length ? <ol className="grid grid-cols-1 gap-3">
          {rules.map((rule, index) => <li key={rule.id} lang={rule.lang} dir={direction(rule.lang, rule.title)} className="grid grid-cols-[auto_1fr] gap-x-3
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
    </div> : null}
    {only !== 'rules' ? <div className="grid min-w-0 grid-cols-1 gap-6">
      {!only ? <section aria-labelledby="realm-moderators" className="grid grid-cols-1 gap-2 rounded-(--zone-radius-card) bg-(--zone-panel)
        p-(--zone-panel-pad)">
        <ModuleHeading id="realm-moderators">{messages.moderators}</ModuleHeading>
        {moderators?.length ? <ul className="grid grid-cols-1">
          {moderators.map(person => <li key={person.id}><PersonRow person={person} /></li>)}
        </ul> : <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <ShieldIcon aria-hidden="true" className="size-4 shrink-0" />
          {moderators === null ? messages.moderatorsHidden : messages.moderatorsNone}</p>}
      </section> : null}
      {listed ? <section aria-labelledby="realm-members" className="grid grid-cols-1 gap-2 rounded-(--zone-radius-card)
        bg-(--zone-panel) p-(--zone-panel-pad)">
        <ModuleHeading id="realm-members">{messages.membersTitle}</ModuleHeading>
        {listed.people.length ? <>
          <p className="text-muted-foreground text-xs">{listed.more ? members : t.membersListed(listed.people.length)}</p>
          <ul className="grid grid-cols-1">
            {listed.people.map(person => <li key={person.id}>
              <PersonRow person={person} note={person.featured ? messages.featured : undefined} /></li>)}
          </ul>
        </> : <p className="text-muted-foreground text-sm">{messages.membersNone}</p>}
      </section> : null}
      {!only && others.length ? <nav aria-labelledby="realm-others" className="grid grid-cols-1 gap-2 rounded-(--zone-radius-card)
        bg-(--zone-panel) p-(--zone-panel-pad)">
        <ModuleHeading id="realm-others">{messages.otherCommunities}</ModuleHeading>
        <ul className="grid grid-cols-1">
          {others.map(other => <li key={other.href}>
            <LocalizedLink href={other.href} className="flex flex-col rounded-lg px-2 py-2 outline-none hover:bg-accent/60
              focus-visible:ring-2 focus-visible:ring-ring">
              <span lang={other.name.lang} dir={direction(other.name.lang, other.name.value)} className="truncate font-medium text-sm">{other.name.value}</span>
              {other.members ? <span className="text-muted-foreground text-xs">{other.members}</span> : null}
            </LocalizedLink></li>)}
        </ul>
        <LocalizedLink href="/discover?tab=communities" className="inline-flex min-h-8 items-center text-primary text-sm underline-offset-4 hover:underline">
          {browseMessages[locale].seeAll}</LocalizedLink>
      </nav> : null}
    </div> : null}
    {children}
  </PageContainer>;
}
