import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
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
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      )}
    >
      {entry.label}
    </a>
  );
}
