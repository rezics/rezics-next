import type { ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import {
  peopleCurrentVisitGlobalHref,
  peopleCurrentVisitNeedsGlobal,
  peopleCurrentVisitReturnHref,
  type PeopleCurrentVisitOrigin,
  type PeopleCurrentVisitSearch,
} from './people-current-visit';

export function PeopleCurrentVisitView({
  locale,
  pathname,
  visit,
  renderEditor,
}: {
  locale: string;
  pathname: string;
  visit: PeopleCurrentVisitSearch;
  renderEditor: (origin?: PeopleCurrentVisitOrigin, returnHref?: string) => ReactNode;
}) {
  const o = { locale: locale as never };
  if (visit.kind === 'invalid')
    return (
      <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6 [overflow-wrap:anywhere]">
        <h1 className="text-2xl font-semibold">{m.people_profile_title({}, o)}</h1>
        <p role="status">{m.people_current_visit_invalid({}, o)}</p>
      </article>
    );

  if (visit.kind === 'origin' && peopleCurrentVisitNeedsGlobal(visit.origin) && visit.correction !== 'global')
    return (
      <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6 [overflow-wrap:anywhere]">
        <h1 className="text-2xl font-semibold">{m.people_profile_title({}, o)}</h1>
        <p role="status">{m.people_current_visit_unsupported({}, o)}</p>
        <a
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          href={peopleCurrentVisitGlobalHref(pathname, visit.origin)}
        >
          {m.people_current_visit_choose_global({}, o)}
        </a>
        <a className="inline-flex min-h-11 items-center underline" href={peopleCurrentVisitReturnHref(visit.origin)}>
          {m.people_current_visit_return({}, o)}
        </a>
      </article>
    );

  const origin = visit.kind === 'origin' ? visit.origin : undefined;
  return (
    <>
      {origin && peopleCurrentVisitNeedsGlobal(origin) ? (
        <p className="mx-auto w-full max-w-4xl px-4 pt-4 text-sm" role="status">
          {m.people_current_visit_global_selected({}, o)}
        </p>
      ) : null}
      {renderEditor(origin, visit.kind === 'biography' ? visit.returnHref : undefined)}
    </>
  );
}
