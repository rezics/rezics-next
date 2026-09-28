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
