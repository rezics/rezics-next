import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { recipeCorrectionHref, recipePublicSubjectHref, type RecipeVisit } from './recipe-current-visit';

export function RecipeEditorEntry({
  id,
  label,
  locale,
  context,
  realm,
  previous,
}: {
  id?: string;
  label?: string;
  locale: string;
  context?: string;
  realm?: string | undefined;
  previous?: string | undefined;
}) {
  const entry = catalogueEntries.recipe({ id, label, locale });
  const returnHref =
    id && context
      ? recipePublicSubjectHref({ id, label: label ?? '' }, locale, { context, ...(realm ? { realm } : {}) }, previous)
      : undefined;
  const visit: RecipeVisit | undefined =
    id && context
      ? {
          context,
          ...(realm ? { realm } : {}),
          ...(returnHref ? { returnHref } : { returnUnsupported: true }),
        }
      : undefined;
  return (
    <a
      href={
        id && visit ? recipeCorrectionHref({ id, label: label ?? '' }, locale, visit satisfies RecipeVisit) : entry.href
      }
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {entry.label}
    </a>
  );
}
