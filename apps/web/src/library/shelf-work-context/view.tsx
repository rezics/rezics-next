import { currentShelfWorkContext, type ShelfContextSource, type ShelfWorkContext } from './context';
import { buttonVariants } from '@rezics/ui/shadcn/button';

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
        <span key={`${fact.property}:${index}`} data-property={fact.property} className="h-auto min-w-0 break-words">
          <span lang={fact.roleLang}>{fact.role}</span>
          {': '}
          {fact.href ? (
            <a
              href={fact.href}
              lang={fact.lang}
              dir="auto"
              className={buttonVariants({ variant: 'link', className: 'relative z-20 h-auto min-h-7' })}
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
