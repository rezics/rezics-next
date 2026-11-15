import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { catalogueEntries } from './catalogue-entry';
import { literaryCurrentVisitSearch, parseLiteraryCurrentVisit } from './literary-current-visit';
import { isLiteraryType } from './literary-profile';

export function LiteraryProfileEntry({
  id,
  label,
  type,
  locale,
  context,
  realm,
  source,
}: {
  id?: string;
  label?: string;
  type?: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  source?: string | undefined;
}) {
  if (type && !isLiteraryType(type)) return null;
  const entry = catalogueEntries.literary({ id, label, locale });
  if (id && type && isLiteraryType(type) && context && source) {
    const search = literaryCurrentVisitSearch({ context, type, source, ...(realm ? { realm } : {}) });
    // Never silently reinterpret an oversized selected visit as a direct Global visit.
    entry.href += parseLiteraryCurrentVisit(search, id, locale).kind === 'visit' ? search : '?invalid=1';
  }
  return (
    <a
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-6 max-w-full shrink whitespace-normal text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
      href={entry.href}
    >
      {entry.label}
    </a>
  );
}
