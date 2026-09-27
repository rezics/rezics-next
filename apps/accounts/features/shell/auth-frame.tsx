'use client';

import type { ReactNode } from 'react';
import { Brand } from './brand.tsx';
import { LocaleSelect } from './locale-select.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** The single-column card that hosts sign-in, sign-up, recovery and consent. */
export function AuthFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  // Phones drop the card and the canvas grid, as a single column reads better there.
  return <main className="aura-canvas flex min-h-dvh flex-col items-center px-4 py-6 max-sm:bg-none sm:justify-center sm:py-12">
    <div className="w-full max-w-[28rem]">
      <section className="rounded-3xl border border-border/60 bg-card px-6 pt-9 pb-8 shadow-(--aura-shadow-card)
        max-sm:border-0 max-sm:bg-transparent max-sm:px-1 max-sm:pt-4 max-sm:shadow-none sm:px-10">
        <Brand label={t.homeLink} product={t.productName} />
        <div className="mt-8">{children}</div>
      </section>
      <footer className="mt-4 flex items-center justify-between gap-4 px-1 sm:px-2"><LocaleSelect /></footer>
    </div>
  </main>;
}

/** Heading block of an auth card, left-aligned like the rest of the card. */
export function AuthHeading({ title, subtitle, children }: { title: string; subtitle?: ReactNode;
  children?: ReactNode }) {
  return <header className="mb-7">
    <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
    {subtitle ? <p className="mt-2 text-base text-muted-foreground">{subtitle}</p> : null}
    {children}
  </header>;
}
