'use client';

import { Button } from '@rezics/ui/button';
import { Spinner } from '@rezics/ui/spinner';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, BookOpenIcon, BotIcon, CheckIcon, ChefHatIcon, ClapperboardIcon, MessagesSquareIcon,
  PuzzleIcon, SparklesIcon, type LucideIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { commandKey } from '../feed/api.ts';
import { useFeed } from '../feed/feed-context.tsx';
import type { SuggestedFollow } from '../feed/types.ts';
import { contentLanguages, type InterestKind, interestKinds } from '../feed/state.ts';
import type { Loaded } from '../feed/types.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import { preferenceCookie } from '../shell/preferences.ts';
import { PICKER_COOKIE } from './cookies.ts';
import type { HomeMessages } from './messages.ts';
import { membersLabel } from './rail.tsx';

const kindIcons: Record<InterestKind, LucideIcon> = { books: BookOpenIcon, software: PuzzleIcon, ai: BotIcon,
  recipes: ChefHatIcon, media: ClapperboardIcon, discussions: MessagesSquareIcon };

const toggle = cn('flex min-h-12 items-center gap-3 rounded-2xl border border-border/70 bg-background px-4 text-start',
  'font-medium text-sm outline-none transition-colors hover:border-primary/40 hover:bg-accent/40',
  'focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/8',
  'aria-pressed:text-primary');

/**
 * A new person's first Home, in three skippable steps as Reddit's sign-up
 * does: what they come for, which languages they read, then suggested
 * communities, all ticked, followed in one step. Home is then full rather
 * than empty.
 */
export function InterestPicker({ locale, messages, kindNames, initial, collapsed: startCollapsed = false }: {
  locale: UiLocale; messages: HomeMessages;
  /** The six kinds' names, shared with the feed's chips. */
  kindNames: Record<InterestKind, string>;
  /** What Main offers (G-302): the kinds it has content for, and languages from the locale. */
  initial: { kinds: { id: InterestKind; available: boolean }[]; languages: string[] };
  /** A person who skipped before sees the slim card first. */
  collapsed?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const { api, actingSubject, avatarQuery } = useFeed();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kinds, setKinds] = useState<ReadonlySet<InterestKind>>(new Set());
  const [languages, setLanguages] = useState<ReadonlySet<string>>(new Set(initial.languages
    .filter(language => (contentLanguages as readonly string[]).includes(language))));
  const [suggested, setSuggested] = useState<Loaded<SuggestedFollow[]> | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState<'idle' | 'busy' | 'failed'>('idle');
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const offered = initial.kinds.length ? initial.kinds.filter(kind => kind.available).map(kind => kind.id)
    : [...interestKinds];

  useEffect(() => {
    if (step !== 3 || suggested) return;
    let current = true;
    void api().suggestions({ interests: [...kinds], languages: [...languages], locale,
      ...(actingSubject ? { actingSubject } : {}) }).then(read => {
      if (!current) return;
      setSuggested(read);
      if (read.ok) setChosen(new Set(read.data.map(item => item.id)));
    });
    return () => { current = false; };
  }, [api, step, suggested, kinds, languages, locale, actingSubject]);

  function skip() {
    document.cookie = preferenceCookie(PICKER_COOKIE, 'skipped', location.protocol === 'https:');
    setCollapsed(true);
  }

  async function finish() {
    if (!actingSubject || !suggested?.ok) return;
    const targets = suggested.data.filter(item => chosen.has(item.id)).map(item => ({ target: item.id, kind: item.kind }));
    if (!targets.length) { skip(); return; }
    setSaving('busy');
    const result = await api().batchFollow(targets, actingSubject, commandKey());
    if (!result.ok) { setSaving('failed'); return; }
    // Following now has posts, so Home opens on it.
    router.refresh();
  }

  if (collapsed) {
    return <section aria-labelledby="picker-later" className="mx-3 flex flex-wrap items-center gap-3 rounded-2xl border
      border-border/60 bg-card px-4 py-3 sm:mx-0">
      <SparklesIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <h2 id="picker-later" className="font-semibold text-sm">{t.pickLaterTitle}</h2>
        <p className="text-muted-foreground text-sm">{t.pickLaterBody}</p>
      </div>
      <Button size="sm" variant="soft" onClick={() => { setCollapsed(false); setStep(1); }}>{t.pickStart}</Button>
    </section>;
  }

  const titles = { 1: [t.pickTitle, t.pickBody], 2: [t.languagesTitle, t.languagesBody],
    3: [t.communitiesTitle, t.communitiesBody] } as const;
  const [title, body] = titles[step];
  return <section aria-labelledby="picker-title" className="aura-surface mx-3 grid gap-5 rounded-3xl border
    border-border/60 p-5 shadow-(--aura-shadow-card) sm:mx-0 sm:p-7">
    <header className="grid gap-1.5">
      <p className="font-medium text-muted-foreground text-xs">{t.step({ step: String(step), total: '3' })}</p>
      <h2 id="picker-title" className="text-balance font-semibold text-xl sm:text-2xl">{title}</h2>
      <p className="text-pretty text-muted-foreground">{body}</p>
    </header>

    {step === 1 ? <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {offered.map(kind => {
        const Icon = kindIcons[kind];
        const on = kinds.has(kind);
        return <li key={kind}><button type="button" aria-pressed={on} className={cn(toggle, 'w-full')}
          onClick={() => setKinds(current => { const next = new Set(current);
            if (on) next.delete(kind); else next.add(kind); return next; })}>
          <Icon aria-hidden="true" className="size-5 shrink-0" />
          <span className="flex-1">{kindNames[kind]}</span>
          {on ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
        </button></li>;
      })}
    </ul> : null}

    {step === 2 ? <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {contentLanguages.map(language => {
        const on = languages.has(language);
        return <li key={language}><button type="button" aria-pressed={on} lang={language}
          className={cn(toggle, 'w-full justify-between')} onClick={() => setLanguages(current => {
            const next = new Set(current); if (on) next.delete(language); else next.add(language); return next; })}>
          {new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language}
          {on ? <CheckIcon aria-hidden="true" className="size-4" /> : null}
          <span className="sr-only" lang={locale}> ({names.of(language)})</span>
        </button></li>;
      })}
    </ul> : null}

    {step === 3 ? !suggested ? <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
      <Spinner aria-hidden="true" />{t.findingCommunities}</p>
      : !suggested.ok || !suggested.data.length ? <p className="text-muted-foreground text-sm">{t.noSuggestions}</p>
        : <ul className="grid gap-2 sm:grid-cols-2">
          {suggested.data.map(item => {
            const on = chosen.has(item.id);
            const members = membersLabel(item.membership.count, t);
            return <li key={item.id}><label className={cn(toggle, 'h-full cursor-pointer items-start py-3',
              on && 'border-primary bg-primary/8')}>
              <input type="checkbox" checked={on} className="mt-2.5 size-4 shrink-0 accent-primary"
                onChange={() => setChosen(current => { const next = new Set(current);
                  if (on) next.delete(item.id); else next.add(item.id); return next; })} />
              <CommunityIcon icon={item.icon} name={item.name.value} size="md" avatarQuery={avatarQuery} />
              <span className="grid min-w-0 flex-1 gap-1">
                <span lang={item.name.language} className="truncate font-semibold text-foreground">{item.name.value}</span>
                <span className="font-normal text-muted-foreground text-xs">{[item.reason.kind === 'official'
                  ? t.reasonOfficial : item.reason.interest ? t.reasonKind({ kind: kindNames[item.reason.interest] })
                    : t.reasonPopular, members].filter(Boolean).join(' · ')}</span>
                {item.sampleWorks.length ? <span aria-hidden="true" className="mt-1 flex gap-1.5">
                  {/* Main's samples name no types yet, so they are drawn as books. */}
                  {item.sampleWorks.map(work => <CatalogueCover key={work.id} work={{ id: work.id, title: work.title,
                    cover: work.cover, kind: 'book', authors: [] }} avatarQuery={avatarQuery} size="xs" />)}
                </span> : null}
              </span>
            </label></li>;
          })}
        </ul> : null}

    <footer className="flex flex-wrap items-center gap-2">
      {step > 1 ? <Button variant="ghost" onClick={() => { setSuggested(null); setStep(step === 3 ? 2 : 1); }}>
        <ArrowLeftIcon aria-hidden="true" />{t.back}</Button> : null}
      <Button variant="ghost" onClick={skip}>{t.skip}</Button>
      <span className="flex-1" />
      {saving === 'failed' ? <p role="status" className="text-destructive-foreground text-sm">{t.followFailed}</p> : null}
      {step < 3 ? <Button onClick={() => setStep(step === 1 ? 2 : 3)}>{t.next}</Button>
        : <Button isLoading={saving === 'busy'} disabled={!suggested} onClick={() => void finish()}>
          {chosen.size ? t.followAndContinue(chosen.size) : t.continueWithoutFollowing}</Button>}
    </footer>
  </section>;
}
