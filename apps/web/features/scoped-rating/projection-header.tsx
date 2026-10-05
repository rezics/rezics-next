'use client';

import { initials } from '@rezics/ui/avatar-initials';
import { badgeVariants } from '@rezics/ui/badge';
import { LocalizedText } from '@rezics/ui/localized-text';
import { cn } from '@rezics/ui/utils';
import { BookOpenIcon, CalendarDaysIcon, FileTextIcon, LockIcon, MapPinIcon, TagIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { WebMediaImage } from '../document-editor/media-image.tsx';
import Link from '../shell/localized-link.tsx';
import { FailureNote } from './failure.tsx';
import { type FrameChip, type FrameKind, frameChips, subjectOf } from './frames.ts';
import { translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import type { AvailableSummary, ResourceSummary } from './types.ts';

/** A subject's picture when one is selected, else the initials of its name. */
export function SubjectAvatar({ avatar, name, className }: {
  avatar: AvailableSummary['avatar']; name: string; className?: string;
}) {
  const src = avatar.kind === 'image' && avatar.url.startsWith('/v1/media/') ? `${BFF_PREFIX}${avatar.url}` : null;
  return <span className={cn('relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-[22%] bg-accent',
    'text-accent-foreground after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit]',
    'after:border after:border-foreground/8 sm:size-12', className)}>
    {src ? <WebMediaImage compact src={src} alt="" className="size-full object-cover" />
      : <span aria-hidden="true" className="font-semibold font-work-title text-lg leading-none">{initials(name)}</span>}
  </span>;
}

const icons: Record<FrameKind, typeof BookOpenIcon> = {
  work: BookOpenIcon, release: CalendarDaysIcon, edition: FileTextIcon, part: MapPinIcon, other: TagIcon,
};

/** The places a rating is in, as chips in each place's own language, linked to its page. */
export function FrameChips({ chips, label, size = 'md' }: { chips: readonly FrameChip[]; label: string; size?: 'md' | 'lg' }) {
  return <ul aria-label={label} className="flex min-w-0 flex-wrap gap-1.5">
    {chips.map(chip => {
      const Icon = icons[chip.kind];
      return <li key={chip.iri} className="min-w-0 max-w-full">
        <Link href={chip.href} className={cn(badgeVariants({ variant: 'outline', size }), 'max-w-full')}>
          <Icon aria-hidden="true" /><span className="truncate"><LocalizedText text={chip.name} /></span></Link>
      </li>;
    })}
  </ul>;
}

/**
 * Who is rated and where: the subject's picture, name and link, then the places as chips, each in its own language and
 * linked to its page. The chips come from the summary's structured parts, so no label is joined from translated words.
 * A place the reader has not reached yet stays hidden whole: its name could give the story away. No summary at all is a
 * failed lookup, which says so and offers `retry`; it is never drawn as a hidden place.
 */
export function ProjectionHeader({ summary, retry, locale, messages, level = 3, page = false, className }: {
  summary: ResourceSummary | null | undefined; retry?: () => void; locale: UiLocale; messages: ScopedRatingMessages;
  level?: 1 | 2 | 3 | 4;
  /** The heading of a page of its own: larger, with the rule a resource page's header has. */
  page?: boolean; className?: string;
}) {
  const t = translate(messages, locale);
  if (!summary) return <FailureNote failure="unavailable" retry={retry} locale={locale} messages={messages} className={className} />;
  const subject = subjectOf(summary, locale);
  if (!subject) {
    return <div data-projection-hidden className={cn('flex items-start gap-3 rounded-2xl bg-muted/60 px-4 py-3', className)}>
      <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="grid gap-0.5">
        <p className="font-medium text-sm">{t.hidden}</p>
        <p className="text-muted-foreground text-sm">{t.hiddenHelp}</p>
      </div>
    </div>;
  }
  const Heading = `h${level}` as const;
  const chips = frameChips(summary ?? undefined, locale);
  return <header data-projection-header className={cn('flex min-w-0 items-start gap-3',
    page && 'items-center gap-4 border-border/60 border-b pb-6', className)}>
    <SubjectAvatar avatar={subject.avatar} name={subject.name.value} className={page ? 'size-16 sm:size-20' : undefined} />
    <div className="grid min-w-0 gap-1.5">
      <Heading className={cn('break-words font-semibold font-work-title leading-tight tracking-tight',
        page ? 'text-balance text-3xl sm:text-4xl' : 'text-lg')}>
        <Link href={subject.href} className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <LocalizedText text={subject.name} as="span" /></Link></Heading>
      <FrameChips chips={chips} label={t.within} size={page ? 'lg' : 'md'} />
    </div>
  </header>;
}
