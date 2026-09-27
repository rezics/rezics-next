import { Avatar, AvatarFallback } from '@rezics/ui/avatar';
import { buttonVariants } from '@rezics/ui/button';
import { ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import Link from '../shell/localized-link.tsx';
import { studioHref } from './agent.ts';
import { AgentSwitcher } from './agent-switcher.tsx';
import type { StudioMessages } from './messages.ts';

/** An Agent's display name, or "Agent 1a2b3c4d" while it has none. */
export function studioAgentName(agent: Pick<AgentOption, 'iri' | 'label'>, messages: { agentFallback: string }): string {
  return agent.label ?? messages.agentFallback.replace('{agent}', agent.iri.slice(-36, -28));
}

export function agentKind(kind: AgentOption['kind'], t: Pick<StudioMessages, 'person' | 'penName' | 'organization' | 'service'>):
  string | null {
  switch (kind) {
    case 'person': return t.person;
    case 'pen-name': return t.penName;
    case 'organization': return t.organization;
    case 'service': return t.service;
    case null: return null;
  }
}

const initial = (name: string) => [...name.trim()].find(char => /[\p{L}\p{N}]/u.test(char))?.toUpperCase() ?? '·';

/** The Studio Agent as a compact identity: initial, name and kind. */
export function AgentIdentity({ agent, messages, locale, size = 'md' }: {
  agent: AgentOption; messages: StudioMessages; locale: UiLocale; size?: 'sm' | 'md';
}) {
  const t = materializeData(messages, { locale });
  const name = studioAgentName(agent, t);
  const kind = agentKind(agent.kind, t);
  return <span className="flex min-w-0 items-center gap-2.5">
    <Avatar size={size === 'sm' ? 'sm' : 'md'}>
      <AvatarFallback className="bg-primary/10 font-semibold text-primary text-sm">{initial(name)}</AvatarFallback>
    </Avatar>
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate font-medium text-sm">{name}</span>
      {kind && size === 'md' ? <span className="truncate text-muted-foreground text-xs">{kind}</span> : null}
    </span>
  </span>;
}

/**
 * The bar above every Studio page: who Studio acts as, a switch to another of
 * this person's identities, and a note when that differs from the session
 * Agent the rest of the site uses.
 */
export function StudioFrame({ agent, agents, session, path, locale, messages, children }: {
  agent: AgentOption; agents: readonly AgentOption[]; session: AgentOption | null; path: string;
  locale: UiLocale; messages: StudioMessages; children: ReactNode;
}) {
  const t = materializeData(messages, { locale });
  const names = Object.fromEntries(agents.map(option => [option.iri, studioAgentName(option, t)]));
  // One minmax(0, 1fr) column: a page's widest content never widens the Studio past the viewport.
  return <div className="grid grid-cols-1">
    <div className="border-border/60 border-b bg-background/80">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-10">
        <section aria-label={t.writingAs} className="flex min-w-0 items-center gap-3">
          <span className="hidden font-medium text-muted-foreground text-xs uppercase tracking-wide sm:inline">
            {t.writingAs}</span>
          <AgentIdentity agent={agent} messages={messages} locale={locale} />
        </section>
        {agents.length > 1 || !session ? <AgentSwitcher current={agent} agents={agents} path={path} names={names}
          labels={{ switchIdentity: t.switchIdentity, identities: t.identities, manageIdentities: t.manageIdentities }} />
          : null}
        {session && session.iri !== agent.iri ? <p className="basis-full text-muted-foreground text-xs">
          {t.sessionDiffers({ agent: names[agent.iri]!, session: studioAgentName(session, t) })}</p> : null}
      </div>
    </div>
    {children}
  </div>;
}

/**
 * A Studio address for an identity this person does not act for. Studio says so and offers
 * their own identities; it never opens someone else's Studio or quietly switches to another.
 */
export function StudioIdentityMissing({ agents, locale, messages }: {
  agents: readonly AgentOption[]; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  return <div className="mx-auto grid w-full max-w-xl gap-6 px-4 py-10 sm:py-16">
    <div className="grid gap-2">
      <h1 className="font-semibold text-2xl">{agents.length ? t.notYourIdentityTitle : t.noIdentityTitle}</h1>
      <p className="text-muted-foreground">{agents.length ? t.notYourIdentityBody : t.noIdentityBody}</p>
    </div>
    {agents.length ? <nav aria-label={t.identities}><ul className="grid gap-2">{agents.map(agent => <li key={agent.iri}>
      <Link href={studioHref(agent)} className="flex items-center justify-between gap-3 rounded-2xl border border-border
        p-3 hover:bg-accent/60"><AgentIdentity agent={agent} messages={messages} locale={locale} />
        <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" /></Link></li>)}</ul></nav> : null}
    <Link href="/identity" className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
      {t.manageIdentities}</Link>
  </div>;
}
