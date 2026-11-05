import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { recipeCorrectionHref, type RecipeVisit } from './recipe-current-visit';

export function RecipeEditorEntry({
  id,
  label,
  locale,
  context,
  realm,
}: {
  id?: string;
  label?: string;
  locale: string;
  context?: string;
  realm?: string | undefined;
}) {
  const entry = catalogueEntries.recipe({ id, label, locale });
  return (
    <a
      href={
        id && context
          ? recipeCorrectionHref({ id, label: label ?? '' }, locale, {
              context,
              ...(realm ? { realm } : {}),
            } satisfies RecipeVisit)
          : entry.href
      }
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {entry.label}
    </a>
  );
}
