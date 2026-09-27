import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CloudOffIcon, LockIcon, LogInIcon, type LucideIcon, RefreshCwIcon, SearchXIcon, ShieldAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { initials } from './format.ts';
import type { ManageMessages } from './messages.ts';
import type { Avatar, LocalizedName, ReadFailure } from './types.ts';

// Tints for images that are missing. Text-safe tones only: the logo red never
// sits behind text (docs/development/design-system.md).
const tints = ['bg-primary/10 text-primary', 'bg-info/10 text-info-foreground',
  'bg-success/10 text-success-foreground', 'bg-warning/10 text-warning-foreground',
  'bg-secondary text-secondary-foreground'] as const;

export function tintOf(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return tints[hash % tints.length]!;
}

/** Localized text from Main with the language it is actually in, for `lang`. */
export function Named({ name, className }: { name: LocalizedName; className?: string }) {
  return <span lang={name.language} dir={name.direction} className={className}>{name.value}</span>;
}

/**
 * A Realm icon or Work cover at list size. Image URLs are Main paths, fetched
 * through the BFF; without an image, a tinted tile with the first letter.
 */
export function Thumb({ image, label, fallbackKey, shape = 'square', className }: {
  image: Avatar | null; label: string; fallbackKey: string; shape?: 'square' | 'cover'; className?: string;
}) {
  const frame = cn('shrink-0 overflow-hidden border border-border/60',
    shape === 'cover' ? 'aspect-[2/3] w-10 rounded-md' : 'size-10 rounded-xl', className);
  if (image?.kind === 'image') {
    return <img src={`${BFF_PREFIX}${image.url}`} alt="" width={image.width} height={image.height}
      loading="lazy" decoding="async" className={cn(frame, 'bg-muted object-cover')} />;
  }
  return <span aria-hidden="true" className={cn(frame, 'grid place-items-center font-semibold text-sm',
    tintOf(image?.key ?? fallbackKey))}>{initials(label)}</span>;
}

/** A person's initials in a circle; names come from their public profile. */
export function AgentMark({ name, iri, size = 'md' }: { name: string; iri: string; size?: 'sm' | 'md' }) {
  return <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full font-semibold',
    size === 'sm' ? 'size-6 text-[11px]' : 'size-8 text-xs', tintOf(iri))}>{initials(name)}</span>;
}

const failureIcons: Record<ReadFailure, LucideIcon> = { denied: LockIcon, missing: SearchXIcon, 'sign-in': LogInIcon,
  moved: RefreshCwIcon, invalid: ShieldAlertIcon, budget: ShieldAlertIcon, unavailable: CloudOffIcon };

/** Why a region has nothing to show, phrased for people, with the next step. */
export function ManageFailure({ failure, locale, messages, retryHref, signInHref, headingLevel = 2, className }: {
  failure: ReadFailure; locale: UiLocale; messages: ManageMessages; retryHref?: string; signInHref?: string;
  headingLevel?: 1 | 2 | 3; className?: string;
}) {
  const t = materializeData(messages, { locale });
  const text: Record<ReadFailure, [string, string]> = {
    denied: [t.deniedTitle, t.deniedHelp], missing: [t.missingTitle, t.missingHelp],
    'sign-in': [t.signInTitle, t.signInHelp], moved: [t.movedTitle, t.movedHelp],
    invalid: [t.invalidTitle, t.invalidHelp], budget: [t.budgetTitle, t.budgetHelp],
    unavailable: [t.unavailableTitle, t.unavailableHelp],
  };
  const [title, help] = text[failure];
  const action: ReactNode = failure === 'sign-in' && signInHref
    ? <a href={signInHref} className={buttonVariants({ size: 'sm' })}>{t.signInTitle}</a>
    : retryHref && ['moved', 'unavailable', 'budget'].includes(failure)
      ? <a href={retryHref} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
        {failure === 'moved' ? t.startOver : t.retry}</a> : null;
  return <EmptyState icon={failureIcons[failure]} title={title} description={help} headingLevel={headingLevel}
    tone={failure === 'unavailable' ? 'destructive' : 'default'} role={failure === 'unavailable' ? 'alert' : undefined}
    className={className}>{action}</EmptyState>;
}

/** A section heading with its explanation and actions, below the page's one <h1>. */
export function SectionHeader({ id, title, description, actions, level = 2 }: {
  id?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode; level?: 2 | 3;
}) {
  const Heading = `h${level}` as const;
  return <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div className="min-w-0 space-y-1">
      <Heading id={id} className={cn('text-balance font-semibold tracking-tight', level === 2 ? 'text-xl' : 'text-base')}>
        {title}</Heading>
      {description ? <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{description}</p> : null}
    </div>
    {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
  </div>;
}
