'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { SparklesIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { preferenceCookie } from '../shell/preferences.ts';
import { PICKER_COOKIE } from './cookies.ts';
import type { HomeMessages } from './messages.ts';

/**
 * A signed-in person who follows nothing yet: an invitation to the first-minute
 * setup (languages, topics that become tabs, communities), never in the way of
 * All · Best below it. Put off once, it stays as a slim line.
 */
export function SetupInvite({ locale, messages, href, later: startLater = false }: {
  locale: UiLocale; messages: HomeMessages;
  /** The setup flow, returning to this Home. */
  href: string;
  /** The reader put it off before. */
  later?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const [later, setLater] = useState(startLater);
  if (later) {
    return <section aria-labelledby="setup-later" className="mx-3 flex flex-wrap items-center gap-3 rounded-2xl border
      border-border/60 bg-card px-4 py-3 sm:mx-0">
      <SparklesIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <h2 id="setup-later" className="font-semibold text-sm">{t.inviteTitle}</h2>
        <p className="text-muted-foreground text-sm">{t.inviteLaterBody}</p>
      </div>
      <Link href={href} className={buttonVariants({ size: 'sm', variant: 'soft' })}>{t.inviteStart}</Link>
    </section>;
  }
  function putOff() {
    document.cookie = preferenceCookie(PICKER_COOKIE, 'skipped', location.protocol === 'https:');
    setLater(true);
  }
  return <section aria-labelledby="setup-title" className="aura-surface mx-3 grid gap-3 rounded-3xl border
    border-border/60 p-5 shadow-(--aura-shadow-card) sm:mx-0 sm:p-6">
    <h2 id="setup-title" className="text-balance font-semibold text-xl">{t.inviteTitle}</h2>
    <p className="max-w-xl text-pretty text-muted-foreground">{t.inviteBody}</p>
    <div className="flex flex-wrap gap-2">
      <Link href={href} className={buttonVariants({ pill: true })}>{t.inviteStart}</Link>
      <Button variant="ghost" pill onClick={putOff}>{t.inviteLater}</Button>
    </div>
  </section>;
}
