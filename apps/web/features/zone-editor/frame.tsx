'use client';

import { ChevronRightIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { ActingAs } from '../manage/realm-frame.tsx';
import type { ManageMessages } from '../manage/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { ZoneEditorSections } from './sections.tsx';
import { useUnsavedZoneEditorSections } from './draft-provider.tsx';

/**
 * The Zone an author is working on: its name, who is acting, and the site sections.
 * Authors can move between home, navigation, Realm and structural theme settings.
 */
export function ZoneEditorFrame({ name, editorPath, agent, locale, manageMessages, sectionsLabel, sectionHome, sectionNavigation,
  sectionRealm, sectionTheme, sectionLifecycle, lifecycleOnly = false, lifecycleAddress, unsavedWork, children }: {
  name: string;
  editorPath: string;
  agent: AgentOption;
  locale: UiLocale;
  manageMessages: ManageMessages;
  sectionsLabel: string;
  sectionHome: string;
  sectionNavigation: string;
  sectionRealm: string;
  sectionTheme: string;
  sectionLifecycle?: string;
  lifecycleOnly?: boolean;
  lifecycleAddress?: { zoneId: string; spaceId: string; returnAddress: string };
  unsavedWork?: string;
  children: ReactNode;
}) {
  const manage = materializeData(manageMessages, { locale });
  const unsaved = useUnsavedZoneEditorSections();
  const sectionLabels = { home: sectionHome, navigation: sectionNavigation, theme: sectionTheme, attachment: sectionRealm };
  return <div className="grid min-w-0 grid-cols-1">
    <div className="border-border/60 border-b bg-background/80">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-2 px-4 pt-3 sm:px-6 lg:px-10">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <nav aria-label={manage.title} className="flex min-w-0 items-center gap-1 text-muted-foreground text-sm">
            <LocalizedLink href="/manage" className="rounded-md px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {manage.title}
            </LocalizedLink>
            <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" />
          </nav>
          <ActingAs agent={agent} locale={locale} messages={manageMessages} />
        </div>
        <h1 className="min-w-0 break-words font-semibold text-xl tracking-tight sm:text-3xl">{name}</h1>
        {unsaved.length && unsavedWork ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          <span className="font-medium">{unsavedWork}: </span>{unsaved.map(section => sectionLabels[section]).join(', ')}
        </p> : null}
        <ZoneEditorSections editorPath={editorPath} sectionsLabel={sectionsLabel} sectionHome={sectionHome}
          sectionNavigation={sectionNavigation} sectionRealm={sectionRealm} sectionTheme={sectionTheme}
          sectionLifecycle={sectionLifecycle} lifecycleOnly={lifecycleOnly} lifecycleAddress={lifecycleAddress} />
      </div>
    </div>
    <div className="mx-auto w-full min-w-0 max-w-7xl px-4 py-3 sm:px-6 sm:py-6 lg:px-10">{children}</div>
  </div>;
}
