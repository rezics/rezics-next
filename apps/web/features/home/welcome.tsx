'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { preferenceCookie } from '../shell/preferences.ts';
import { WELCOME_COOKIE } from './cookies.ts';
import type { HomeMessages } from './messages.ts';

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
  return <section aria-labelledby="welcome-title" className="relative mx-3 grid gap-2 rounded-2xl border
    border-border/60 p-4 pe-12 sm:mx-0">
    <h2 id="welcome-title" className="text-balance font-semibold text-base">{t.welcomeTitle}</h2>
    <p className="max-w-xl text-pretty text-muted-foreground text-sm">{t.welcomeBody}</p>
    <div className="flex flex-wrap gap-2">
      <a href={signUpHref} className={buttonVariants({ variant: 'outline', size: 'sm', pill: true })}>{t.signUp}</a>
      <a href={signInHref} className={buttonVariants({ variant: 'ghost', size: 'sm', pill: true })}>{t.signIn}</a>
    </div>
    <Button variant="ghost" size="icon-sm" aria-label={t.dismiss} title={t.dismiss} onClick={dismiss}
      className="absolute end-3 top-3 text-muted-foreground"><XIcon aria-hidden="true" /></Button>
  </section>;
}
