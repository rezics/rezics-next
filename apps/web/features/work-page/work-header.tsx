import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { BookOpenIcon, LockIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { CSSProperties, ReactNode } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { languageName, paragraphs, typeNames } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import type { WorkCover as Cover, WorkHeader as Header } from './types.ts';

// Fallback cover hues on the oklch wheel: ink blue, teal, green, rust, plum and rose.
const coverHues = [255, 205, 155, 35, 310, 5] as const;

/**
 * The Work's cover. A selected image is served through the BFF; without one,
 * Main's fallback key picks a stable color and the title is set on it, like
 * a plain bound edition, so the Work stays recognizable. The title sits beside
 * it too, so the cover is decorative.
 */
export function WorkCover({ cover, title, language, className }: {
  cover: Cover; title: string; language: string; className?: string;
}) {
  const frame = cn('aspect-[2/3] w-full overflow-hidden rounded-xl border border-border/60 shadow-(--aura-shadow-card)',
    className);
  if (cover.kind === 'image') {
    return <img src={`${BFF_PREFIX}${cover.url}`} width={cover.width} height={cover.height} alt=""
      className={cn(frame, 'bg-muted object-cover')} />;
  }
  const hue = coverHues[Number.parseInt(cover.key.slice(0, 4), 16) % coverHues.length];
  const style = { '--cover-hue': hue } as CSSProperties;
  return <div aria-hidden="true" style={style} className={cn(frame, 'flex flex-col justify-between p-2 sm:p-4',
    'bg-[linear-gradient(165deg,oklch(0.46_0.1_var(--cover-hue)),oklch(0.3_0.08_var(--cover-hue)))]')}>
    <span lang={language} className="line-clamp-5 hyphens-auto break-words font-work-title text-[0.6875rem]/snug
      text-white sm:text-base/snug">
      {title}</span>
    <span className="h-px w-1/3 bg-white/50" />
  </div>;
}

/**
 * The Work's identity: cover, title in the Work-title face, types, Main
 * Version and credits, and the primary action. Every text type's action is
 * Read; package and prompt types will add Install and Copy.
 */
export function WorkHeader({ work, credits, readHref, locale, messages }: {
  work: Header; credits: ReactNode; readHref: string; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const types = typeNames(work.types, t);
  return <header className="aura-surface grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 rounded-3xl border
    border-border/60 p-4 shadow-(--aura-shadow-card) sm:grid-cols-[9rem_minmax(0,1fr)] sm:grid-rows-[auto_1fr]
    sm:gap-x-6 sm:p-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-x-8 lg:p-8">
    <WorkCover cover={work.cover} title={work.title.value} language={work.title.language}
      className="self-start sm:row-span-2" />
    <div className="grid min-w-0 content-start gap-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="soft">{t.work}</Badge>
        {types.map(type => <Badge key={type} variant="outline" className="bg-card">{type}</Badge>)}
        {work.disclosure === 'restricted'
          ? <Badge variant="warning" title={t.restrictedHelp}><LockIcon aria-hidden="true" />{t.restricted}</Badge> : null}
      </div>
      <h1 lang={work.title.language} dir={work.title.direction} className="text-balance break-words font-semibold
        font-work-title text-2xl/tight sm:text-4xl/tight">{work.title.value}</h1>
      {work.title.basis === 'fallback' ? <p className="text-muted-foreground text-xs">
        {t.titleFallback({ requested: languageName(locale, locale),
          shown: languageName(work.title.language, locale) })}
      </p> : null}
      {work.originalTitle && work.originalTitle.value !== work.title.value
        ? <p className="text-muted-foreground text-sm">{t.originalTitle}{': '}
          <span lang={work.originalTitle.language} dir={work.originalTitle.direction}
            className="font-work-title text-foreground">{work.originalTitle.value}</span></p> : null}
      {credits}
      <p className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-sm">
        <span>{work.selectedLanguage
          ? t.mainVersionIn({ language: languageName(work.selectedLanguage, locale) }) : t.mainVersion}</span>
        {work.mainVersionLabel ? <span lang={work.mainVersionLabel.language} className="font-medium text-foreground">
          {work.mainVersionLabel.value}</span> : null}
      </p>
    </div>
    <div className="col-span-2 flex flex-wrap content-start gap-2 sm:col-span-1 sm:col-start-2">
      <Link href={readHref} className={buttonVariants({ size: 'lg' })}>
        <BookOpenIcon aria-hidden="true" />{t.read}</Link>
    </div>
  </header>;
}

/** The Work's recorded description, in the reader's language when Main has one. */
export function WorkAbout({ work, messages }: { work: Header; messages: WorkPageMessages }) {
  if (!work.description) return null;
  return <section aria-labelledby="work-about" className="grid max-w-3xl gap-2">
    <h2 id="work-about" className="font-semibold text-lg/7">{messages.about}</h2>
    <div lang={work.description.language} dir={work.description.direction}
      className="grid gap-3 text-pretty text-[15px]/7 text-foreground/90">
      {paragraphs(work.description.value).map((line, index) => <p key={index}>{line}</p>)}
    </div>
  </section>;
}
