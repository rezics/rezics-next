import { buttonVariants } from '@rezics/ui/shadcn/button';
import { gameCorrectionHref } from './game-current-visit';
import { catalogueEntries } from './catalogue-entry';

export type GameProfileEntryProps = {
  id?: string;
  type?: string;
  label?: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  release?: string | undefined;
};

/** Both the standalone link and the installed contribution menu use this same source intent. */
export function gameProfileEntry({ id, type, label = '', locale, context, realm, release }: GameProfileEntryProps) {
  const entry = catalogueEntries.gameProfile({ id, type, label, locale });
  if (!entry) return;
  const href = id && type && context
    ? gameCorrectionHref({ id, type, label, locale, context, realm, release })
    : entry.href;
  return href ? { ...entry, href } : undefined;
}

export function GameProfileEntry(props: GameProfileEntryProps) {
  const entry = gameProfileEntry(props);
  if (!entry) return null;
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} data-game-correction-entry="" href={entry.href}>
      {entry.label}
    </a>
  );
}
