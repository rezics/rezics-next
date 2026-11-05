import { m } from '../../paraglide/messages.js';
import { ViewHeading } from '../pages/view-heading';
import type { GameCurrentVisit } from './game-current-visit';

/** No Global editor is mounted behind an unsupported source reading. */
export function GameVisitNotice({
  locale,
  visit,
  globalHref,
  invalid = false,
}: {
  locale: string;
  visit?: GameCurrentVisit | undefined;
  globalHref?: string | undefined;
  invalid?: boolean;
}) {
  const o = { locale: locale as never };
  return (
    <article className="mx-auto min-w-0 max-w-4xl space-y-5 [overflow-wrap:anywhere]">
      <ViewHeading label={m.game_profile_title({}, o)} headingClassName="font-sans" />
      <p role="alert">{invalid ? m.game_visit_invalid({}, o) : m.game_visit_unsupported({}, o)}</p>
      {visit && (
        <p className="text-sm">
          {m.game_visit_context({ context: visit.context }, o)}
          {visit.realm ? ` · ${m.game_visit_realm({ realm: visit.realm }, o)}` : ''}
        </p>
      )}
      <nav className="flex flex-wrap gap-3">
        {visit?.source && (
          <a className="inline-flex min-h-11 items-center underline" href={visit.source}>
            {m.game_visit_return({}, o)}
          </a>
        )}
        {globalHref && (
          <a className="inline-flex min-h-11 items-center underline" href={globalHref}>
            {m.game_visit_global({}, o)}
          </a>
        )}
      </nav>
    </article>
  );
}
