import { ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { ActingAs } from '../manage/realm-frame.tsx';
import type { ManageMessages } from '../manage/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';

/**
 * The Zone an author is working on: its name, who is acting, and the site sections.
 * Navigation and theme join this list later; only Home is here.
 */
export function ZoneEditorFrame({ name, editorPath, agent, locale, manageMessages, sectionsLabel, sectionHome, children }: {
  name: string;
  editorPath: string;
  agent: AgentOption;
  locale: UiLocale;
  manageMessages: ManageMessages;
  sectionsLabel: string;
  sectionHome: string;
  children: ReactNode;
}) {
  const manage = materializeData(manageMessages, { locale });
  return <div className="grid min-w-0 grid-cols-1">
    <div className="border-border/60 border-b bg-background/80">
      <div className="mx-auto grid w-full max-w-7xl gap-3 px-4 pt-4 sm:px-6 lg:px-10">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <nav aria-label={manage.title} className="flex min-w-0 items-center gap-1 text-muted-foreground text-sm">
            <LocalizedLink href="/manage" className="rounded-md px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {manage.title}
            </LocalizedLink>
            <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" />
          </nav>
          <ActingAs agent={agent} locale={locale} messages={manageMessages} />
        </div>
        <h1 className="min-w-0 break-words font-semibold text-2xl tracking-tight sm:text-3xl">{name}</h1>
        <nav aria-label={sectionsLabel} className="pb-3">
          <LocalizedLink href={editorPath} aria-current="page" className="inline-flex rounded-md px-2 py-1 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {sectionHome}
          </LocalizedLink>
        </nav>
      </div>
    </div>
    <div className="mx-auto w-full min-w-0 max-w-7xl px-4 py-6 sm:px-6 lg:px-10">{children}</div>
  </div>;
}
