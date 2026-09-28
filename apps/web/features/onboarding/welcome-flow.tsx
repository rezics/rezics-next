'use client';

import { Button } from '@rezics/ui/button';
import { Spinner } from '@rezics/ui/spinner';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, CheckIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CatalogueCover } from '../catalogue/cover.tsx';
import type { FollowKind, Loaded, OnboardingChoices, SuggestedFollow } from '../feed/types.ts';
import { PICKER_COOKIE } from '../home/cookies.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import { preferenceCookie } from '../shell/preferences.ts';
import type { OnboardingMessages } from './messages.ts';
import { LanguagePicker } from './language-picker.tsx';
import { broaderName, MAX_TOPICS, startingLanguages, toggled, topicGroups } from './topics.ts';
import { mainWelcomeApi, type WelcomeApi } from './welcome-api.ts';

type T = ReturnType<typeof materializeData<OnboardingMessages>>;

const tile = cn('group/tile relative flex w-full rounded-2xl border border-border/70 bg-background text-start',
  'outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
  'aria-pressed:border-primary aria-pressed:bg-primary/8 disabled:opacity-60');

function Check({ on }: { on: boolean }) {
  return <span aria-hidden="true" className={cn('grid size-5 shrink-0 place-items-center rounded-full border',
    on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
    {on ? <CheckIcon className="size-3.5" /> : null}</span>;
}

export interface WelcomeFlowProps {
  locale: UiLocale;
  messages: OnboardingMessages;
  actingSubject: string;
  avatarQuery: string;
  /** What Main offers: content languages and topics by type; null when it could not answer. */
  choices: OnboardingChoices | null;
  /** The reader's saved content languages, if any. */
  savedLanguages: readonly string[] | null;
  /** Where the reader was going: Home, or the page that sent them to sign in. */
  next: string;
  /** Stories: an in-memory Main, and a start step. */
  api?: WelcomeApi;
  initialStep?: 1 | 2 | 3;
}

/**
 * A new reader's first minute, in three skippable steps as X, Pinterest and
 * Reddit ask: the languages they read, topics from the shared vocabulary by
 * type with covers (each becomes a pinned Home tab), then communities
 * suggested for those choices, all followed in one step. It ends on a Home
 * that already has something to read.
 */
export function WelcomeFlow({ locale, messages, actingSubject, avatarQuery, choices, savedLanguages, next, api: given,
  initialStep = 1 }: WelcomeFlowProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const api = useRef<WelcomeApi | null>(given ?? null);
  const client = () => api.current ??= mainWelcomeApi(actingSubject);
  const offered = choices?.languages ?? [locale];
  const initialLanguages = useMemo(() => startingLanguages(savedLanguages, offered, locale),
    [savedLanguages, offered, locale]);
  const groups = useMemo(() => topicGroups(choices?.groups ?? []), [choices]);
  const [step, setStep] = useState<1 | 2 | 3>(initialStep);
  const [languages, setLanguages] = useState<string[]>(initialLanguages);
  /** The reader confirmed languages with Next; skipping the step changes no setting. */
  const [languagesChosen, setLanguagesChosen] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<Loaded<SuggestedFollow[]> | null>(null);
  const [communities, setCommunities] = useState<string[]>([]);
  const [saving, setSaving] = useState<'idle' | 'busy' | 'failed'>('idle');
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const requested = useRef('');

  /** Communities for what was chosen, all ticked, read once per choice. */
  function toCommunities(chosenTopics: string[]) {
    setStep(3);
    const concepts = chosenTopics, languagesRead = languagesChosen ? languages : [];
    const key = JSON.stringify([concepts, languagesRead]);
    if (requested.current === key) return;
    requested.current = key;
    setSuggested(null);
    void client().suggestions({ concepts, languages: languagesRead, locale }).then(read => {
      if (requested.current !== key) return;
      setSuggested(read);
      setCommunities(read.ok ? read.data.map(item => item.id) : []);
    });
  }

  function leave() {
    router.push(next);
    router.refresh();
  }

  function putOff() {
    document.cookie = preferenceCookie(PICKER_COOKIE, 'skipped', location.protocol === 'https:');
    leave();
  }

  async function finish(follow: boolean) {
    setSaving('busy');
    const chosen = follow && suggested?.ok ? suggested.data.filter(item => communities.includes(item.id)) : [];
    const targets: { target: string; kind: FollowKind }[] = [...topics.map(topic => ({ target: topic, kind: 'concept' as const })),
      ...chosen.map(item => ({ target: item.id, kind: item.kind }))];
    const changedLanguages = languagesChosen && languages.join() !== (savedLanguages ?? []).join();
    const saved = await Promise.all([changedLanguages ? client().saveLanguages(languages) : true, client().follow(targets)]);
    if (saved.some(ok => !ok)) { setSaving('failed'); return; }
    // Nothing chosen at all: Home keeps a slim invitation instead of the full one.
    if (!targets.length) document.cookie = preferenceCookie(PICKER_COOKIE, 'skipped', location.protocol === 'https:');
    leave();
  }

  const titles = { 1: [t.languagesTitle, t.languagesBody], 2: [t.topicsTitle, t.topicsBody],
    3: [t.communitiesTitle, t.communitiesBody] } as const;
  const [title, body] = titles[step];
  return <section aria-labelledby="setup-step" className="grid gap-6">
    <header className="grid gap-4">
      <div className="flex items-center gap-3">
        <p className="font-medium text-muted-foreground text-xs">{t.step({ step: String(step), total: '3' })}</p>
        <ol aria-hidden="true" className="flex flex-1 gap-1.5">
          {[1, 2, 3].map(index => <li key={index} className={cn('h-1 flex-1 rounded-full',
            index <= step ? 'bg-primary' : 'bg-border')} />)}
        </ol>
        <Button variant="ghost" size="sm" onClick={putOff}>{t.skipSetup}</Button>
      </div>
      <div className="grid gap-1.5">
        <h2 id="setup-step" className="text-balance font-semibold text-2xl sm:text-3xl">{title}</h2>
        <p className="max-w-2xl text-pretty text-muted-foreground">{body}</p>
      </div>
    </header>

    {step === 1 ? <LanguagePicker t={t} locale={locale} suggested={offered} value={languages}
      onChange={setLanguages} /> : null}

    {step === 2 ? groups.length ? <div className="grid gap-6">
      <p role="status" className="font-medium text-muted-foreground text-sm">
        {topics.length >= MAX_TOPICS ? t.topicsFull : t.topicsChosen(topics.length)}</p>
      {groups.map(group => <section key={group.heading} aria-label={t[group.heading] as string} className="grid gap-3">
        <h3 className="font-semibold text-lg">{t[group.heading] as string}</h3>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {group.topics.map(topic => {
            const on = topics.includes(topic.id);
            const broader = broaderName(groups, topic);
            return <li key={topic.id}><button type="button" aria-pressed={on}
              disabled={!on && topics.length >= MAX_TOPICS} className={cn(tile, 'h-full flex-col gap-3 p-3')}
              onClick={() => setTopics(current => toggled(current, topic.id))}>
              <span aria-hidden="true" className="flex h-20 items-end gap-1.5">
                {topic.samples.map(sample => <CatalogueCover key={sample.id} avatarQuery={avatarQuery} size="xs"
                  work={{ id: sample.id, title: sample.title, cover: sample.cover, kind: group.cover, authors: [] }} />)}
              </span>
              <span className="flex w-full items-start gap-2">
                <span className="grid min-w-0 flex-1">
                  <span lang={topic.name.language} className="truncate font-semibold">{topic.name.value}</span>
                  {broader ? <span className="truncate text-muted-foreground text-xs">
                    {t.inTopic({ topic: broader })}</span> : null}
                </span>
                <Check on={on} />
              </span>
            </button></li>;
          })}
        </ul>
      </section>)}
    </div> : <p className="text-muted-foreground">{t.noTopics}</p> : null}

    {step === 3 ? !suggested ? <p role="status" className="flex items-center gap-2 text-muted-foreground">
      <Spinner aria-hidden="true" />{t.findingCommunities}</p>
      : !suggested.ok || !suggested.data.length ? <p className="text-muted-foreground">{t.noSuggestions}</p>
        : <ul aria-label={title} className="grid gap-3 sm:grid-cols-2">
          {suggested.data.map(item => {
            const on = communities.includes(item.id);
            return <li key={item.id}><button type="button" aria-pressed={on}
              className={cn(tile, 'h-full items-start gap-3 p-4')}
              onClick={() => setCommunities(current => on ? current.filter(id => id !== item.id) : [...current, item.id])}>
              <CommunityIcon icon={item.icon} name={item.name.value} size="md" avatarQuery={avatarQuery} />
              <span className="grid min-w-0 flex-1 gap-1">
                <span lang={item.name.language} className="truncate font-semibold">{item.name.value}</span>
                <span className="text-muted-foreground text-xs">{[reason(item, t, names),
                  members(item, t)].filter(Boolean).join(' · ')}</span>
                {item.sampleWorks.length ? <span aria-hidden="true" className="mt-1 flex gap-1.5">
                  {item.sampleWorks.map(work => <CatalogueCover key={work.id} avatarQuery={avatarQuery} size="xs"
                    work={{ id: work.id, title: work.title, cover: work.cover, kind: 'book', authors: [] }} />)}
                </span> : null}
              </span>
              <Check on={on} />
            </button></li>;
          })}
        </ul> : null}

    <footer className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-border/60 border-t bg-background/95
      px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:backdrop-blur-none">
      {step > 1 ? <Button variant="ghost" onClick={() => setStep(step === 3 ? 2 : 1)}>
        <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{t.back}</Button> : null}
      <span className="flex-1" />
      {saving === 'failed' ? <p role="alert" className="basis-full text-destructive-foreground text-sm sm:basis-auto">
        {t.saveFailed}</p> : null}
      {step === 1 ? <>
        <Button variant="ghost" onClick={() => { setLanguages(initialLanguages); setLanguagesChosen(false); setStep(2); }}>
          {t.skip}</Button>
        <Button onClick={() => { setLanguagesChosen(true); setStep(2); }}>{t.next}</Button>
      </> : step === 2 ? <>
        <Button variant="ghost" onClick={() => { setTopics([]); toCommunities([]); }}>{t.skip}</Button>
        <Button onClick={() => toCommunities(topics)}>{t.next}</Button>
      </> : <>
        <Button variant="ghost" disabled={saving === 'busy'} onClick={() => void finish(false)}>{t.skip}</Button>
        <Button isLoading={saving === 'busy'} disabled={!suggested} onClick={() => void finish(true)}>
          {communities.length && suggested?.ok ? t.followAndFinish(communities.length) : t.finish}</Button>
      </>}
    </footer>
  </section>;
}

function reason(item: SuggestedFollow, t: T, names: Intl.DisplayNames): string {
  if (item.reason.kind === 'matching-concept' && item.reason.concept.name) {
    return t.reasonTopic({ topic: item.reason.concept.name.value });
  }
  if (item.reason.kind === 'popular' && item.reason.language) {
    return t.reasonLanguage({ language: names.of(item.reason.language) ?? item.reason.language });
  }
  return t.reasonPopular;
}

function members(item: SuggestedFollow, t: T): string | null {
  const count = item.membership.count;
  return count.kind === 'exact' ? t.members(count.value) : count.kind === 'estimated' ? t.membersAbout(count.value) : null;
}
