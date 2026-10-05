import { ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { agentShort } from './format.ts';
import type { ManageMessages } from './messages.ts';
import { AgentMark, Named, Thumb } from './parts.tsx';
import { AccessRealmTabs } from './settings-navigation.tsx';
import type { RealmHeader } from './types.ts';
import { accessMessages } from './settings-messages.ts';

/** The acting Agent, shown before any decision is made (Identity before action). */
export function ActingAs({ agent, locale, messages }: { agent: AgentOption; locale: UiLocale; messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  const name = agent.label ?? t.agentFallback({ id: agentShort(agent.iri) });
  return <section aria-label={t.actingAs} className="flex min-w-0 items-center gap-2 text-sm">
    <span className="hidden text-muted-foreground sm:inline">{t.actingAs}</span>
    <AgentMark name={name} iri={agent.iri} size="sm" />
    <span className="truncate font-medium">{name}</span>
  </section>;
}

/**
 * Every Realm management page: the Realm, who is acting, and the sections.
 * The Realm's name is the page's one <h1>; each section titles itself with <h2>.
 */
export function RealmFrame({ realm, address = realm, header, agent, locale, messages, children, settingsAllowed }: {
  realm: string;
  /** How the address names the Realm: its official Zone's segment, or its ID. Links keep it. */
  address?: string;
  header: RealmHeader | null; agent: AgentOption; locale: UiLocale; messages: ManageMessages; children: ReactNode; settingsAllowed?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const fallback = t.realmFallback({ id: realm.slice(0, 8) });
  return <div className="grid grid-cols-1">
    <div className="border-border/60 border-b bg-background/80">
      <div className="mx-auto grid w-full max-w-7xl gap-3 px-4 pt-4 sm:px-6 lg:px-10">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <nav aria-label={t.title} className="flex min-w-0 items-center gap-1 text-muted-foreground text-sm">
            <LocalizedLink href="/manage" className="rounded-md px-1 outline-none hover:text-foreground
              focus-visible:ring-2 focus-visible:ring-ring">{t.title}</LocalizedLink>
            <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" />
          </nav>
          <ActingAs agent={agent} locale={locale} messages={messages} />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <Thumb image={header?.icon ?? null} label={header?.name.value ?? fallback} fallbackKey={realm} />
          <h1 className="min-w-0 break-words font-semibold text-2xl tracking-tight sm:text-3xl">
            {header ? <Named name={header.name} /> : fallback}</h1>
        </div>
        <AccessRealmTabs realm={realm} address={address} actor={agent.iri} settingsAllowed={settingsAllowed} labels={{ nav: t.realmNav, queue: t.tabQueue, log: t.tabLog, members: t.tabMembers,
          roles: t.tabRoles, showcase: t.tabShowcase, settings: t.tabSettings }} />
        <LocalizedLink href={`/manage/r/${address}/requests`} className="w-fit rounded-md pb-3 text-primary text-sm underline-offset-4 hover:underline">
          {accessMessages[locale].requests}</LocalizedLink>
      </div>
    </div>
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10">{children}</div>
  </div>;
}
