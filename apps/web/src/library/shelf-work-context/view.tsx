import { currentShelfWorkContext, type ShelfContextSource, type ShelfWorkContext } from './context';

/** Independent links keep creator/release destinations outside the work title's stretched link. */
export function ShelfWorkContextView({
  entry,
  locale,
  isCurrent,
}: {
  entry: ShelfContextSource & { workContext?: ShelfWorkContext | null };
  locale: string;
  isCurrent?: (() => boolean) | undefined;
}) {
  const context = currentShelfWorkContext(entry, locale);
  if (!(isCurrent?.() ?? true) || !context?.facts.length) return null;
  return (
    <span data-slot="shelf-work-context" className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
      {context.facts.map((fact, index) => (
        <span key={`${fact.property}:${index}`} data-property={fact.property} className="min-w-0 break-words">
          <span lang={fact.roleLang}>{fact.role}</span>
          {': '}
          {fact.href ? (
            <a
              href={fact.href}
              lang={fact.lang}
              dir="auto"
              className="relative z-20 inline-flex min-h-6 items-center rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(event) => {
                event.stopPropagation();
                if (!(isCurrent?.() ?? true)) event.preventDefault();
              }}
            >
              {fact.text}
            </a>
          ) : (
            <span lang={fact.lang} dir="auto">
              {fact.text}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
