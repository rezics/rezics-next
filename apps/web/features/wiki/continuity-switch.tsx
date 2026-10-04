'use client';

import { buttonVariants } from '@rezics/ui/button';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from '@rezics/ui/sheet';
import { cn } from '@rezics/ui/utils';
import type { ZoneText } from '@rezics/zone-sdk';
import { CheckIcon, GitBranchIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useEffect, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ScopedRatingMessages } from '../scoped-rating/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type ContinuityChoice, offContinuity, sameContinuity, withContinuity } from './continuity.ts';

/** One continuity a franchise can be read in: a narrative continuity (Canon, Legends) or a Work's own timeline. */
export interface ContinuityOption {
  /** The continuity's UUID, as the address carries it. */
  id: string;
  label: ZoneText;
  kind: 'narrative' | 'work';
}

const row =
  'flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 text-start text-sm outline-none ' +
  'transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:border-border ' +
  'aria-[current=true]:bg-accent/60';

function Text({ text }: { text: ZoneText }) {
  return <bdi lang={text.lang || undefined} dir={text.dir}>{text.value}</bdi>;
}

/**
 * Reads the franchise in the continuity a person chooses. Off by default, so nothing is hidden until someone asks; a
 * host may default its readers into one. The choice is written to the address, so every page the reader moves to keeps
 * it, and Main applies it as the `frame` of its reads. Choosing navigates, as the reading position does: the pages
 * are read again on the server for the new continuity.
 */
export function ContinuitySwitch({ here, current, fallback = offContinuity, options, locale, messages, children, className }: {
  /** The address being shown, with its query: every choice is this address with the continuity changed. */
  here: string;
  current: ContinuityChoice;
  /** The continuity the host defaults its readers into, if any. */
  fallback?: ContinuityChoice;
  options: readonly ContinuityOption[];
  locale: UiLocale;
  messages: ScopedRatingMessages;
  /** Further words in the bar beside the switch. */
  children?: ReactNode;
  className?: string;
}) {
  const t = materializeData(messages, { locale });
  const [open, setOpen] = useState(false);
  // Tests and scripts wait for this before they press the trigger: the server-rendered button does nothing until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const chosen = current.kind === 'at' ? options.find(option => option.id === current.continuity) : undefined;
  const off: ContinuityChoice = offContinuity;
  const close = () => setOpen(false);
  const groups = [
    { kind: 'narrative' as const, title: t.continuityStory },
    { kind: 'work' as const, title: t.continuityWork },
  ].map(group => ({ ...group, items: options.filter(option => option.kind === group.kind) })).filter(group => group.items.length);

  return <div data-continuity-switch className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
    <Sheet open={open} onOpenChange={details => setOpen(details.open)}>
      <SheetTrigger disabled={!hydrated} data-hydrated={hydrated ? 'true' : undefined}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-start')}>
        <GitBranchIcon aria-hidden="true" />
        <span data-continuity-current className="min-w-0">
          {t.continuity}: {chosen ? <Text text={chosen.label} /> : current.kind === 'at' ? '…' : t.continuityAll}</span>
      </SheetTrigger>
      <SheetContent placement="bottom" className="max-h-[85svh] sm:mx-auto sm:max-w-lg">
        <SheetHeader title={t.continuityTitle} description={t.continuityBody} />
        <SheetBody>
          <ul data-continuity-options className="grid gap-1">
            <li>
              <LocalizedLink href={withContinuity(here, off, fallback)} documentNavigation prefetch={false} className={row}
                aria-current={sameContinuity(current, off)} onClick={close}>
                <CheckIcon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', !sameContinuity(current, off) && 'invisible')} />
                <span className="grid gap-0.5">
                  <span className="font-medium">{t.continuityAll}</span>
                  <span className="text-muted-foreground">{t.continuityAllNote}</span>
                </span>
              </LocalizedLink>
            </li>
            {groups.map(group => <li key={group.kind} className="grid gap-1">
              <p className="mt-2 px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">{group.title}</p>
              <ul className="grid gap-1">
                {group.items.map(option => {
                  const choice: ContinuityChoice = { kind: 'at', continuity: option.id };
                  const here_ = sameContinuity(current, choice);
                  return <li key={option.id}>
                    <LocalizedLink href={withContinuity(here, choice, fallback)} documentNavigation prefetch={false} className={row}
                      aria-current={here_} onClick={close}>
                      <CheckIcon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', !here_ && 'invisible')} />
                      <span className="font-medium"><Text text={option.label} /></span>
                    </LocalizedLink>
                  </li>;
                })}
              </ul>
            </li>)}
          </ul>
        </SheetBody>
      </SheetContent>
    </Sheet>
    {current.kind === 'at' ? <>
      <span data-continuity-note className="text-muted-foreground text-sm">
        {t.continuityNow({ name: chosen?.label.value ?? '…' })}</span>
      <LocalizedLink href={withContinuity(here, off, fallback)} documentNavigation prefetch={false} data-continuity-clear
        className="rounded-sm text-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {t.continuityClear}</LocalizedLink>
    </> : null}
    {children}
  </div>;
}
