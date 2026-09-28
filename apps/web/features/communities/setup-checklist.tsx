'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { CheckIcon, ClipboardIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import Link from '../shell/localized-link.tsx';
import { communityText as words } from './messages.ts';

type Setup = { topics: boolean; invite: boolean; skipped?: string[] };
const key = (actor: string, realm: string) => `rezics:community-setup:${actor}:${realm}`;

/** The creator's local, dismissible first-minutes guide; API reads verify public setup and the first post. */
export function CommunitySetupChecklist({ realm, actor, path, locale, rules, icon, banner }: {
  realm: string; actor: string; path: string; locale: UiLocale;
  rules: boolean; icon: boolean; banner: boolean;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [firstPost, setFirstPost] = useState(false);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key(actor, realm)) ?? 'null') as Setup | null;
      if (value && typeof value.topics === 'boolean' && typeof value.invite === 'boolean') setSetup(value);
    } catch { /* The guide is optional when local storage is unavailable. */ }
    void browserMainApi().v1.realms({ realm: realm.slice(-36) }).threads.get({
      query: { sort: 'new', limit: 1 },
    }).then(result => setFirstPost(Boolean(result.data?.items.length))).catch(() => undefined);
  }, [actor, realm]);
  const skipped = new Set(setup?.skipped ?? []);
  const finished = Boolean(setup) && [rules, setup?.topics ?? false, icon, banner, firstPost,
    setup?.invite ?? false].every((done, index) => done || skipped.has(
    ['rules', 'topics', 'icon', 'banner', 'firstPost', 'invite'][index]!));
  useEffect(() => {
    if (!finished) return;
    try { localStorage.removeItem(key(actor, realm)); } catch { /* optional */ }
    setSetup(null);
  }, [actor, realm, finished]);
  if (!setup) return null;
  const steps = [
    { id: 'rules', label: words.rules[locale], done: rules,
      href: `/manage/r/${realm.slice(-36)}/settings` },
    { id: 'topics', label: words.topics[locale], done: setup.topics, href: null },
    { id: 'icon', label: words.icon[locale], done: icon, href: null },
    { id: 'banner', label: words.banner[locale], done: banner, href: null },
    { id: 'firstPost', label: words.firstPost[locale], done: firstPost,
      href: `${path}/submit` },
    { id: 'invite', label: words.invite[locale], done: setup.invite, href: null },
  ];
  function save(next: Setup) {
    setSetup(next);
    try { localStorage.setItem(key(actor, realm), JSON.stringify(next)); } catch { /* optional */ }
  }
  return <section aria-labelledby="community-setup-title" className="grid gap-4 rounded-2xl border border-border
    bg-card p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="community-setup-title" className="font-semibold text-lg">{words.setupTitle[locale]}</h2>
        <p className="text-muted-foreground text-sm">{words.setupHelp[locale]}</p></div>
    </div>
    <ol className="grid gap-2 sm:grid-cols-2">{steps.map(step => <li key={step.id}
      className="flex min-w-0 items-center gap-2 rounded-xl border border-border/70 p-3 text-sm">
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full border border-border">
        {step.done || skipped.has(step.id) ? <CheckIcon className="size-3.5" /> : null}</span>
      <span className="min-w-0 flex-1">{step.label}</span>
      {!step.done && !skipped.has(step.id) ? step.href
        ? <Link href={step.href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {words.setupGo[locale]}</Link>
        : step.id === 'invite' ? <Button type="button" size="sm" variant="ghost" onClick={() => {
          void navigator.clipboard.writeText(new URL(path, location.origin).href).then(() =>
            save({ ...setup, invite: true })).catch(() => undefined);
        }}><ClipboardIcon aria-hidden="true" />{words.copyInvite[locale]}</Button>
          : null : null}
      {!step.done && !skipped.has(step.id) ? <Button type="button" size="sm" variant="ghost"
        onClick={() => save({ ...setup, skipped: [...skipped, step.id] })}>
        {words.setupSkip[locale]}</Button> : null}
    </li>)}</ol>
  </section>;
}
