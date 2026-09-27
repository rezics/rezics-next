'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { XIcon } from 'lucide-react';
import Link from 'next/link';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Community } from '../shell/communities.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import { preferenceCookie } from '../shell/preferences.ts';
import { WELCOME_COOKIE } from './cookies.ts';
import type { HomeMessages } from './messages.ts';

/** The official Zones as tiles, for everyone, above the feed. */
export function OfficialZoneTiles({ zones, locale, messages }: { zones: readonly Community[]; locale: UiLocale;
  messages: HomeMessages }) {
  const t = materializeData(messages, { locale });
  if (!zones.length) return null;
  return <section aria-labelledby="official-zones" className="grid gap-2 px-3 sm:px-0">
    <h2 id="official-zones" className="font-semibold text-sm">{t.officialZones}
      <span className="ms-2 font-normal text-muted-foreground">{t.officialZonesIntro}</span></h2>
    <ul className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
      {zones.map(zone => <li key={zone.id} className="shrink-0">
        <Link href={localizedPath(zone.href, locale)} className="flex h-12 items-center gap-2.5 rounded-2xl border
          border-border/60 bg-card pe-4 ps-2.5 font-medium text-sm outline-none transition-colors hover:border-primary/40
          focus-visible:ring-2 focus-visible:ring-ring">
          <CommunityIcon icon={zone.icon} name={zone.name} size="md" className="size-8" />
          <span lang={zone.language}>{zone.name}</span>
        </Link>
      </li>)}
    </ul>
  </section>;
}

/** For signed-out visitors: why to join, dismissible, never in the way of the feed. */
export function WelcomeCard({ locale, messages, signUpHref, signInHref, dismissed = false }: {
  locale: UiLocale; messages: HomeMessages; signUpHref: string; signInHref: string; dismissed?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const [hidden, setHidden] = useState(dismissed);
  if (hidden) return null;
  function dismiss() {
    document.cookie = preferenceCookie(WELCOME_COOKIE, 'dismissed', location.protocol === 'https:');
    setHidden(true);
  }
  return <section aria-labelledby="welcome-title" className="aura-surface relative mx-3 grid gap-3 rounded-3xl border
    border-border/60 p-5 pe-12 shadow-(--aura-shadow-card) sm:mx-0 sm:p-6 sm:pe-14">
    <h2 id="welcome-title" className="text-balance font-semibold text-xl">{t.welcomeTitle}</h2>
    <p className="max-w-xl text-pretty text-muted-foreground">{t.welcomeBody}</p>
    <div className="flex flex-wrap gap-2">
      <a href={signUpHref} className={buttonVariants({ pill: true })}>{t.signUp}</a>
      <a href={signInHref} className={buttonVariants({ variant: 'outline', pill: true })}>{t.signIn}</a>
    </div>
    <Button variant="ghost" size="icon-sm" aria-label={t.dismiss} title={t.dismiss} onClick={dismiss}
      className="absolute end-3 top-3 text-muted-foreground"><XIcon aria-hidden="true" /></Button>
  </section>;
}
