import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';

export function RecipeEditorEntry({ id, label, locale }: { id?: string; label?: string; locale: string }) {
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={id ? `${subjectHref({ id, label: label ?? '' }, locale).href}/recipe` : `/${locale}/catalogue/recipe`}
    >
      {id ? m.recipe_edit({}, { locale: locale as never }) : m.recipe_title({}, { locale: locale as never })}
    </a>
  );
}
