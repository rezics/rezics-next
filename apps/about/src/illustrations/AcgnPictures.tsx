import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { ArrowRight, Check, Gamepad2, Link2, Lock, Monitor } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import { row, type Picture, type Words } from './parts.ts';
import { Plate } from './Plate.tsx';
import { glassTide, kindsOfStory, world } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

const kind = (key: (typeof kindsOfStory)[number]['key']) =>
  kindsOfStory.find((entry) => entry.key === key)!;
const named = (key: Parameters<typeof kind>[0], lang: string) =>
  kind(key).names.find((name) => name.lang === lang) ?? kind(key).names[0];

/** The label of a release's kind and the badge variant that suits it. */
function releaseKind(words: Words['words']) {
  const w = words.release;
  return {
    original: { name: w.original, variant: 'outline' },
    official: { name: w.official, variant: 'success' },
    fan: { name: w.fan, variant: 'info' },
  } as const;
}

/* ---------- Hero ---------- */

/** One visual novel, three releases: the same cover in three languages, each saying what it is. */
export function ThreeReleases({ words }: Words) {
  const kinds = releaseKind(words);
  const covers = [
    { lang: 'ja', title: glassTide.original },
    { lang: 'en', title: glassTide.title },
    { lang: 'zh-Hant', title: '玻璃之潮' },
  ] as const;
  return (
    <Plate className="flex flex-col gap-6">
      <ol className="grid grid-cols-3 gap-3 sm:gap-5">
        {glassTide.releases.map((release, index) => {
          const cover = covers[index]!;
          const Icon = release.platform === 'PC' ? Monitor : Gamepad2;
          return (
            <li
              key={release.lang}
              data-arrive
              style={at(index * 8)}
              className="flex flex-col items-center gap-3"
            >
              <WorkCover
                kind="package"
                id={glassTide.id}
                title={cover.title}
                lang={cover.lang}
                className="w-full max-w-32 shadow-[0_18px_30px_-18px_rgb(0_0_0/0.6)]"
              />
              <p lang={release.lang} className="font-semibold">
                {localeNames[release.lang]}
              </p>
              <Badge variant={kinds[release.kind].variant} size="md">
                {kinds[release.kind].name}
              </Badge>
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Icon aria-hidden className="size-4" />
                {release.platform}
              </p>
              <div className="h-1.5 w-full max-w-32 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${release.done}%` }}
                />
              </div>
              <p className="text-sm tabular-nums text-muted-foreground">
                {release.done === 100
                  ? words.release.complete
                  : fill(words.release.covers, { n: release.done })}
              </p>
            </li>
          );
        })}
      </ol>
    </Plate>
  );
}

/* ---------- Choosing a visual novel, one step at a time ---------- */

/** One visual novel, three releases side by side: language, platform, who translated it and how much. */
function Releases({ words }: Words) {
  const w = words.release;
  const kinds = releaseKind(words);
  return (
    <>
      <div className="flex items-center gap-4">
        <WorkCover
          kind="package"
          id={glassTide.id}
          title={glassTide.title}
          lang="en"
          className="w-20 shrink-0"
        />
        <div>
          <p lang="en" className="font-work-title text-xl font-semibold">
            {glassTide.title}
          </p>
          <p lang="ja" className="text-sm text-muted-foreground">
            {glassTide.original}
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {glassTide.releases.map((release, index) => {
          const Icon = release.platform === 'PC' ? Monitor : Gamepad2;
          return (
            <li
              key={release.lang}
              data-arrive
              style={at(index * 7)}
              className="rounded-2xl border border-border bg-background p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span lang={release.lang} className="font-semibold">
                  {localeNames[release.lang]}
                </span>
                <Badge variant={kinds[release.kind].variant} size="sm">
                  {kinds[release.kind].name}
                </Badge>
                <span className="ms-auto flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Icon aria-hidden className="size-4" />
                  {release.platform}
                </span>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${release.done}%` }}
                  />
                </div>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {release.done === 100 ? w.complete : fill(w.covers, { n: release.done })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The fan translation's credit: its group, the version it was made from and how far it goes. */
function Provenance({ words }: Words) {
  const w = words.release;
  const fan = glassTide.releases[2];
  return (
    <>
      <p className="flex flex-wrap items-center gap-2">
        <span lang="zh-Hant" className="font-semibold">
          {localeNames['zh-Hant']}
        </span>
        <Badge variant="info" size="sm">
          {w.fan}
        </Badge>
      </p>
      <div data-arrive className="rounded-2xl border border-border bg-background p-4">
        <p lang="zh-Hant" className="text-lg font-semibold">
          {fan.by}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{words.acgn.translationGroup}</p>
      </div>
      <p
        data-arrive
        style={at(8)}
        className="flex items-center gap-3 rounded-2xl border border-border bg-background p-4"
      >
        <WorkCover
          kind="package"
          id={glassTide.id}
          title={glassTide.original}
          lang="ja"
          className="w-12 shrink-0"
        />
        <span>
          <span lang="ja" className="block font-semibold">
            {localeNames.ja}
          </span>
          <span className="block text-sm text-muted-foreground">
            {fill(words.acgn.madeFrom, { n: '1.2' })}
          </span>
        </span>
      </p>
      <div data-arrive style={at(16)} className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary" style={{ width: `${fan.done}%` }} />
        </div>
        <span className="text-sm font-semibold tabular-nums">
          {fill(w.covers, { n: fan.done })}
        </span>
      </div>
    </>
  );
}

/** One list for every unit: a route, an episode, a chapter, a volume. */
function Track({ words }: Words) {
  const a = words.acgn;
  const items = [
    { key: 'visualNovel', lang: 'en', place: fill(a.route, { n: 3 }), percent: 60 },
    { key: 'anime', lang: 'en', place: fill(a.episode, { n: 7 }), percent: 58 },
    { key: 'manga', lang: 'en', place: fill(words.shelf.chapter, { n: 41 }), percent: 70 },
    { key: 'lightNovel', lang: 'en', place: fill(words.shelf.volume, { n: 7 }), percent: 78 },
  ] as const;
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item, index) => {
        const work = kind(item.key);
        return (
          <li
            key={item.key}
            data-arrive
            style={at(index * 6)}
            className="flex items-center gap-3 rounded-2xl border border-border bg-background p-3"
          >
            <WorkCover
              kind={work.cover}
              id={work.id}
              title={named(item.key, item.lang).text}
              lang={item.lang}
              className="w-10 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline justify-between gap-2">
                <span lang={item.lang} className="truncate font-work-title font-semibold">
                  {named(item.key, item.lang).text}
                </span>
                <span className="shrink-0 text-sm font-semibold">{item.place}</span>
              </p>
              <div className="mt-2 h-1.5 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${item.percent}%` }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Discussion held back past the route the reader has reached. */
function Discuss({ words }: Words) {
  const a = words.acgn;
  const posts = [
    {
      by: 'mira.reads',
      route: 1,
      text: 'The lighthouse scene sets the whole tone. Take your time in it.',
    },
    { by: 'hollow_oak', route: 3, text: 'Route 3 quietly changes what the first route meant.' },
    { by: '灯里', route: 4, text: '' },
  ] as const;
  return (
    <>
      <p className="flex items-center justify-between gap-3">
        <span className="font-semibold">{a.posts}</span>
        <Badge variant="soft" size="md">
          <Check aria-hidden />
          {fill(a.route, { n: 3 })}
        </Badge>
      </p>
      <ul className="flex flex-col gap-2.5">
        {posts.map((post, index) => (
          <li
            key={post.by}
            data-arrive
            style={at(index * 7)}
            className={cn(
              'rounded-xl border px-3.5 py-3',
              post.text ? 'border-border bg-background' : 'border-dashed border-border',
            )}
          >
            <p className="flex items-center justify-between gap-2 text-sm">
              <span lang="en" className="font-semibold">
                {post.by}
              </span>
              <span className="text-muted-foreground">{fill(a.route, { n: post.route })}</span>
            </p>
            {post.text ? (
              <p lang="en" className="type-body mt-1">
                {post.text}
              </p>
            ) : (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Lock aria-hidden className="size-4" />
                {fill(a.hiddenUntil, { place: fill(a.route, { n: 4 }).toLowerCase() })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export type AcgnStage = 'releases' | 'provenance' | 'track' | 'discuss';

/** Choosing a visual novel, honestly: a stage at a time. */
export function AcgnFlow({ words, stage }: Words & { stage: AcgnStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'releases' ? <Releases words={words} /> : null}
      {stage === 'provenance' ? <Provenance words={words} /> : null}
      {stage === 'track' ? <Track words={words} /> : null}
      {stage === 'discuss' ? <Discuss words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Season({ words }: Words) {
  const a = words.acgn;
  const anime = kind('anime');
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      <li className={row}>
        <span className="flex items-center gap-3">
          <WorkCover
            kind={anime.cover}
            id={anime.id}
            title={named('anime', 'en').text}
            lang="en"
            className="w-8 shrink-0"
          />
          <span>
            <span lang="en" className="block font-semibold">
              {named('anime', 'en').text}
            </span>
            <span className="block text-muted-foreground">{fill(a.episode, { n: 8 })}</span>
          </span>
        </span>
        <Badge variant="soft" size="sm">
          {fill(a.airs, { day: words.release.friday })}
        </Badge>
      </li>
      <li className={row}>
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-[22%] bg-secondary"
          >
            <Gamepad2 className="size-4 text-primary" />
          </span>
          <span>
            <span lang="en" className="block font-semibold">
              {named('game', 'en').text}
            </span>
            <span className="block text-muted-foreground">1.4</span>
          </span>
        </span>
        <Badge variant="success" size="sm">
          {words.acgn.released}
        </Badge>
      </li>
    </ul>
  );
}

/** The novel, the manga and the anime of one story, linked, the anime held back. */
function Adaptations({ words }: Words) {
  const a = words.acgn;
  const chain = [
    { label: words.realm.lightNovel, held: false },
    { label: words.realm.manga, held: false },
    { label: words.realm.anime, held: true },
  ];
  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <ol className="flex items-center gap-2">
        {chain.map((item, index) => (
          <li key={item.label} className="flex items-center gap-2">
            {index > 0 ? <Link2 aria-hidden className="size-4 text-muted-foreground" /> : null}
            <Badge variant={item.held ? 'outline' : 'soft'} size="md">
              {item.label}
            </Badge>
          </li>
        ))}
      </ol>
      <p className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        <Lock aria-hidden className="size-4 shrink-0" />
        {a.heldBack}
      </p>
    </div>
  );
}

function Credits({ words }: Words) {
  const a = words.acgn;
  const credits = [
    { name: '春日 みなと', lang: 'ja', role: a.voice, character: world.kaede },
    { name: 'Hikaru Morino', lang: 'en', role: a.director, character: '' },
  ] as const;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {credits.map((credit) => (
        <li
          key={credit.name}
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm"
        >
          <p className="flex items-center justify-between gap-2">
            <span lang={credit.lang} className="font-semibold">
              {credit.name}
            </span>
            <Badge variant="outline" size="sm">
              {credit.role}
            </Badge>
          </p>
          {credit.character ? (
            <p lang="en" className="mt-0.5 text-muted-foreground">
              {fill(a.asCharacter, { name: credit.character })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The ACGN Zone: the same catalogue as every other Zone, seen as seasons, releases and discussion. */
function Zone({ words }: Words) {
  const tabs = words.acgn.zoneTabs;
  const shown = ['anime', 'game', 'manga'] as const;
  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      <ul className="flex gap-1.5">
        {[tabs.seasons, tabs.releases, tabs.discussion].map((tab, index) => (
          <li
            key={tab}
            className={cn(
              'rounded-full px-3 py-1 text-sm font-semibold',
              index === 0 ? 'bg-(--cloth-ink) text-(--cloth)' : 'border border-current opacity-75',
            )}
          >
            {tab}
          </li>
        ))}
      </ul>
      <ul className="flex items-end gap-3">
        {shown.map((key) => {
          const work = kind(key);
          return (
            <li key={key} className="w-20 shrink-0">
              <WorkCover
                kind={work.cover}
                id={work.id}
                title={named(key, 'en').text}
                lang="en"
                className="w-full shadow-[0_14px_24px_-14px_rgb(0_0_0/0.6)]"
              />
            </li>
          );
        })}
        <li aria-hidden className="pb-2">
          <ArrowRight className="size-5 opacity-70" />
        </li>
      </ul>
    </div>
  );
}

export const acgnVignettes: Record<string, Picture> = {
  season: Season,
  adaptations: Adaptations,
  credits: Credits,
  zone: Zone,
};
