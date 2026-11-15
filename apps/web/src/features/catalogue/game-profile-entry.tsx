import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { gameCorrectionHref } from './game-current-visit';
import type { GameClassificationLocator } from './game-current-visit-descriptor';
import { catalogueEntries } from './catalogue-entry';

export type GameProfileEntryProps = {
  id?: string;
  type?: string;
  label?: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  release?: string | undefined;
  reader?: string | null | undefined;
  selection?: GameClassificationLocator | undefined;
};

/** Both the standalone link and the installed contribution menu use this same source intent. */
export function gameProfileEntry({
  id,
  type,
  label = '',
  locale,
  context,
  realm,
  release,
  reader,
  selection,
}: GameProfileEntryProps) {
  const entry = catalogueEntries.gameProfile({ id, type, label, locale });
  if (!entry) return;
  const href =
    id && type && context
      ? gameCorrectionHref({ id, type, label, locale, context, realm, release, reader, selection })
      : entry.href;
  return href ? { ...entry, href } : undefined;
}

export function GameProfileEntry(props: GameProfileEntryProps) {
  const entry = gameProfileEntry(props);
  if (!entry) return null;
  return (
    <a
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      )}
      data-game-correction-entry=""
      href={entry.href}
    >
      {entry.label}
    </a>
  );
}
