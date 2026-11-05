import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';

export function RecipeVisitNotice({
  locale,
  invalid,
  sourceHref,
  globalHref,
}: {
  locale: string;
  invalid?: boolean;
  sourceHref?: string | undefined;
  globalHref?: string | undefined;
}) {
  const o = { locale: locale as never };
  return (
    <section className="space-y-4" aria-label={m.recipe_edit({}, o)}>
      {invalid && <PageHeading>{m.recipe_edit({}, o)}</PageHeading>}
      <p role="alert">{invalid ? m.recipe_visit_invalid({}, o) : m.recipe_visit_unsupported({}, o)}</p>
      {sourceHref && (
        <a className="inline-flex min-h-11 items-center underline" href={sourceHref}>
          {m.recipe_visit_return({}, o)}
        </a>
      )}
      {globalHref && (
        <a className="inline-flex min-h-11 items-center underline" href={globalHref}>
          {m.recipe_visit_global({}, o)}
        </a>
      )}
    </section>
  );
}
