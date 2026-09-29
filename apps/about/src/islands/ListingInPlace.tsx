import { badgeVariants } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Languages } from 'lucide-react';
import { useInView } from 'motion/react';
import * as m from 'motion/react-m';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fill } from '../i18n/fill.ts';
import type { UiLocale } from '../i18n/locales.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { lantern, lanternRecord, type RecordLang } from '../illustrations/sample.ts';
import { instant, MotionRoot, useMotion, type Motion } from './motion.tsx';

export interface ListingInPlaceProps {
  /** UI labels keep this language even inside a record shown in another language. */
  locale: UiLocale;
  words: Pick<IllustrationCopy, 'record' | 'release'>;
  /** Each reading language's name in itself, from `localeNames`; a prop, so the island does not bundle the locale table. */
  languageNames: Record<RecordLang, string>;
}

const { languages } = lanternRecord;
/** The edition whose cover a reading language shows: its own, or the original when it has none. */
const coverEdition = (lang: RecordLang) =>
  lantern.editions.find((edition) => edition.lang === lang) ?? lantern.editions[0];
/** The synopsis a reading language gets: its translation, or the Japanese original. */
const synopsisLang = (lang: RecordLang): Exclude<RecordLang, 'ko'> =>
  lang in lanternRecord.synopsis ? (lang as Exclude<RecordLang, 'ko'>) : 'ja';

/**
 * One field in every reading language, stacked in one grid cell so the field is always as
 * tall as its longest version (nothing below it moves), with the active one shown. A swap
 * is a short fade and rise, `order` steps after the swap begins.
 */
function Swap({
  active,
  order,
  motion,
  langOf = (lang) => lang,
  className,
  children,
}: {
  active: RecordLang;
  order: number;
  motion: Motion;
  langOf?: (lang: RecordLang) => string;
  className?: string;
  children: (lang: RecordLang) => ReactNode;
}) {
  return (
    <div className={cn('swap', className)}>
      {languages.map((lang) => {
        const shown = lang === active;
        return (
          <m.div
            key={lang}
            lang={langOf(lang)}
            data-active={shown}
            aria-hidden={shown ? undefined : true}
            initial={false}
            animate={shown ? { opacity: 1, y: [8, 0] } : { opacity: 0, y: -6 }}
            transition={{ ...motion.swap, delay: shown ? order * motion.stagger : 0 }}
          >
            {children(lang)}
          </m.div>
        );
      })}
    </div>
  );
}

/**
 * A Japanese light novel's record, presented in the reading language chosen above it: the
 * title, credits, synopsis and tags change in place, field by field, while each edition
 * keeps its own title. Korean has no synopsis translation yet, so it shows the original,
 * marked. Server-rendered in English; once hydrated, it starts in Japanese and turns into
 * English when it first comes into view (not with reduced motion), then follows the reader.
 */
export function ListingInPlace({ words, languageNames, locale }: ListingInPlaceProps) {
  const [lang, setLang] = useState<RecordLang>('en');
  const [autoplay, setAutoplay] = useState(false);
  // The reset to the original happens out of sight, so it is instant.
  const [unseen, setUnseen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.55, once: true });
  const reader = useMotion();
  const motion = unseen ? instant : reader;
  const text = words.record;

  // Before the reader reaches it, set the record back to its original so they see it turn.
  useEffect(() => {
    const box = root.current?.getBoundingClientRect();
    const visible = box !== undefined && box.top < window.innerHeight && box.bottom > 0;
    if (reader.reduced || visible) return;
    setUnseen(true);
    setLang('ja');
    setAutoplay(true);
  }, [reader.reduced]);

  useEffect(() => {
    if (!autoplay || !inView) return;
    const timer = setTimeout(() => {
      setUnseen(false);
      setLang('en');
      setAutoplay(false);
    }, 1100);
    return () => clearTimeout(timer);
  }, [autoplay, inView]);

  function choose(next: RecordLang) {
    setUnseen(false);
    setAutoplay(false);
    setLang(next);
  }

  return (
    <MotionRoot>
      <div
        ref={root}
        data-instant={unseen || undefined}
        className="w-full rounded-[1.75rem] border border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float) sm:p-7"
      >
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <legend className="float-start me-1 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <Languages aria-hidden className="size-4" />
            {text.showIn}
          </legend>
          {languages.map((option) => (
            <label key={option} className="record-language">
              <input
                type="radio"
                name="record-language"
                value={option}
                checked={lang === option}
                onChange={() => choose(option)}
                className="sr-only"
              />
              <span lang={option}>{languageNames[option]}</span>
            </label>
          ))}
        </fieldset>

        <div className="mt-6 grid gap-6 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-7">
          <Swap active={lang} order={0} motion={motion} className="w-28 sm:w-full">
            {(option) => {
              const edition = coverEdition(option);
              return (
                <WorkCover
                  kind="book"
                  id={lantern.id}
                  title={edition.title}
                  lang={edition.lang}
                  authors={[lantern.author[edition.lang]]}
                  className="w-full rounded-[6px] shadow-(--aura-shadow-card)"
                />
              );
            }}
          </Swap>

          <div className="min-w-0">
            <Swap active={lang} order={1} motion={motion}>
              {(option) => (
                <p className="font-work-title text-3xl font-semibold leading-tight">
                  {lanternRecord.title[option]}
                </p>
              )}
            </Swap>
            <Swap active={lang} order={2} motion={motion} className="mt-1.5">
              {(option) =>
                option === 'ja' ? (
                  <span className="text-sm">&nbsp;</span>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    <span lang={locale}>{text.originalTitle}</span>{' '}
                    <span lang="ja" className="font-semibold text-foreground">
                      {lanternRecord.title.ja}
                    </span>
                  </p>
                )
              }
            </Swap>

            <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
              <dt lang={locale} className="text-muted-foreground">
                {text.story}
              </dt>
              <dd>
                <Swap active={lang} order={3} motion={motion}>
                  {(option) => {
                    const author = lanternRecord.author[option];
                    return typeof author === 'string' ? (
                      <span className="font-semibold">{author}</span>
                    ) : (
                      <span className="font-semibold">
                        {author.map((part, index) => (
                          <ruby key={part.text} className={index > 0 ? 'ms-1' : undefined}>
                            {part.text}
                            <rt className="text-[0.625rem] font-normal text-muted-foreground">
                              {part.reading}
                            </rt>
                          </ruby>
                        ))}
                      </span>
                    );
                  }}
                </Swap>
              </dd>
              <dt lang={locale} className="text-muted-foreground">
                {text.illustration}
              </dt>
              <dd>
                <Swap active={lang} order={3} motion={motion}>
                  {(option) => (
                    <span className="font-semibold">{lanternRecord.illustrator[option]}</span>
                  )}
                </Swap>
              </dd>
            </dl>
          </div>
        </div>

        <div className="mt-6 border-t border-border pt-5">
          <p lang={locale} className="text-sm font-semibold text-muted-foreground">
            {text.synopsis}
          </p>
          <Swap active={lang} order={4} motion={motion} langOf={synopsisLang} className="mt-2">
            {(option) => (
              <div>
                <p className="font-work-title text-[1.0625rem] leading-relaxed">
                  {lanternRecord.synopsis[synopsisLang(option)]}
                </p>
                {option === 'ko' ? (
                  <p lang={locale} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className={badgeVariants({ variant: 'outline', size: 'sm' })}>
                      {text.original}
                    </span>
                    <span className="text-muted-foreground">
                      {fill(text.untranslated, { language: languageNames.ko })}
                    </span>
                    <span className="font-semibold text-primary">{text.suggest}</span>
                  </p>
                ) : null}
              </div>
            )}
          </Swap>
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <p lang={locale} className="text-sm font-semibold text-muted-foreground">
              {text.tags}
            </p>
            <Swap active={lang} order={5} motion={motion} className="mt-2">
              {(option) => (
                <ul className="flex flex-wrap gap-1.5">
                  {lanternRecord.tags.map((tag) => (
                    <li key={tag.en} className={badgeVariants({ variant: 'soft', size: 'md' })}>
                      {tag[option]}
                    </li>
                  ))}
                </ul>
              )}
            </Swap>
          </div>
          <div>
            <p lang={locale} className="text-sm font-semibold text-muted-foreground">
              {text.editions}
            </p>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {lantern.editions.map((edition) => (
                <li
                  key={edition.lang}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 transition-colors',
                    edition.lang === lang ? 'bg-accent text-accent-foreground' : '',
                  )}
                >
                  <span lang={edition.lang} className="truncate font-semibold">
                    {edition.title}
                  </span>
                  <span lang={locale} className="shrink-0 text-muted-foreground">
                    {edition.lang === 'ja' ? words.release.original : words.release.official}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </MotionRoot>
  );
}
