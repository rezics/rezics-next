import { ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ManageMessages } from './messages.ts';
import { ActingAs } from './realm-frame.tsx';

/**
 * Platform management: the site's own address and the acting Agent, without
 * Realm settings or roles. Like a Realm's frame, its title is the page's one <h1>.
 */
export function SiteFrame({ agent, locale, messages, children }: {
  agent: AgentOption; locale: UiLocale; messages: ManageMessages; children: ReactNode;
}) {
  const t = materializeData(messages, { locale });
  return <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-10">
    <div className="grid gap-3 border-border/60 border-b pb-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <nav aria-label={t.title} className="flex min-w-0 items-center gap-1 text-muted-foreground text-sm">
          <LocalizedLink href="/manage" className="rounded-md px-1 outline-none hover:text-foreground
            focus-visible:ring-2 focus-visible:ring-ring">{t.title}</LocalizedLink>
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
        </nav>
        <ActingAs agent={agent} locale={locale} messages={messages} />
      </div>
      <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">{t.siteTitle}</h1>
      <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{t.siteHelp}</p>
    </div>
    {children}
  </div>;
}
