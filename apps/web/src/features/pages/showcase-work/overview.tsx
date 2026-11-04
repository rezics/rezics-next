import { useId } from 'react';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import type { Related, Subject } from '../../../subject/types';
import type { RelationDefinition } from '../../../subject/relations';
import { PlainLink, spoilerLevel, type PageLink } from '../shared';
import { SpoilerGate } from '../values';
import { withSubjectVisitReturn } from '../subject-visit-navigation';
import { workDestinations, type ShowcaseWorkKind } from './model';

const workLink =
  'inline-flex min-h-11 min-w-11 w-full flex-col items-start justify-center gap-1 rounded-sm py-2 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function kindLabel(kind: ShowcaseWorkKind, locale: string) {
  const options = { locale: locale as never };
  switch (kind) {
    case 'visual-novel':
      return m.work_franchise_kind_visual_novel({}, options);
    case 'game':
      return m.work_franchise_kind_game({}, options);
    case 'screen':
      return m.work_franchise_kind_screen({}, options);
    case 'book':
      return m.work_franchise_kind_book({}, options);
  }
}

export function WorkFranchiseOverview({
  subject,
  related,
  definitions,
  locale,
  returnTo,
  relationsHref,
  readerSpoiler = 0,
  link = PlainLink,
}: {
  subject: Subject;
  related: Related;
  definitions: Record<string, RelationDefinition>;
  locale: string;
  /** A validated same-locale Subject visit return, usually this work or the route's admitted opener. */
  returnTo: string;
  relationsHref?: string;
  readerSpoiler?: number;
  link?: PageLink;
}) {
  const heading = useId();
  const options = { locale: locale as never };
  const destinations = workDestinations(subject, related, definitions);
  if (!destinations.length) return null;
  const Link = link;

  return (
    <section
      data-slot="work-franchise"
      aria-labelledby={heading}
      className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
    >
      <h2 id={heading} className="text-xl font-semibold">
        {m.work_franchise_title({}, options)}
      </h2>
      <ul className="grid min-w-0 gap-3 md:grid-cols-2">
        {destinations.map(({ id, property, statement, relation, target, kind }) => {
          const title = pickText(target.labels, locale);
          const label = title.text || m.subject_value_unlabelled({}, options);
          const address = subjectHref({ id, label }, locale);
          const href = withSubjectVisitReturn(address.href, returnTo, locale);
          const kindName = kindLabel(kind, locale);
          const content = (
            <div className="min-w-0 space-y-1">
              {relation.forwardLabel ? (
                <p className="text-sm text-muted-foreground">{relation.forwardLabel}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{m.work_franchise_relation_label_unavailable({}, options)}</p>
              )}
              <Link href={href} className={workLink}>
                <span className="text-sm font-medium text-muted-foreground">{kindName}</span>
                <span lang={title.lang ?? undefined} className="text-base font-semibold leading-snug">
                  {label}
                </span>
              </Link>
            </div>
          );
          const key = `${subject.id}:${subject.revision}:${subject.release}:${property}:${statement.id}`;
          return (
            <li key={key} className="min-w-0 rounded-lg border border-border p-3 sm:p-4">
              {spoilerLevel(statement) > readerSpoiler ? (
                <SpoilerGate
                  label={m.thread_reveal_spoiler({}, options)}
                  hideLabel={m.subject_spoiler_hide({}, options)}
                >
                  {content}
                </SpoilerGate>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>
      {relationsHref ? (
        <p>
          <Link
            href={relationsHref}
            className="inline-flex min-h-11 min-w-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.subject_view_all({ label: m.subject_relations({}, options) }, options)}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
