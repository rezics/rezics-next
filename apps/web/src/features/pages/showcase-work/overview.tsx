import { useContext, useId } from 'react';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import type { Related, Subject } from '../../../subject/types';
import type { RelationDefinition } from '../../../subject/relations';
import { PlainLink, spoilerLevel, type PageLink } from '../shared';
import { SpoilerGate } from '../values';
import { connectionReturnHref, withSubjectVisitReturn } from '../subject-visit-navigation';
import { OverviewContext, holderItems, statementItems, type Section } from '../overview';
import type { ProfileRelationWindow } from '../views';
import { kindLabel, WorkRelation } from './relation';
import { workDestinations, workWindowRelations } from './model';

const workLink =
  'inline-flex min-h-11 min-w-11 w-full flex-col items-start justify-center gap-1 rounded-sm py-2 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function WorkFranchiseOverview({
  subject,
  related,
  definitions,
  locale,
  returnTo,
  relationsHref,
  readerSpoiler = 0,
  link = PlainLink,
  windows,
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
  windows?: ProfileRelationWindow[];
}) {
  const heading = useId();
  const options = { locale: locale as never };
  const value = useContext(OverviewContext);
  const native = windows?.filter((window) => Object.hasOwn(definitions, window.property));
  const selected = native?.find((window) => (workWindowRelations(subject.id, window)?.length ?? 0) > 0) ?? native?.[0];
  if (selected && value) {
    const direction = selected.direction === 'inverse' ? 'in' : 'out';
    const relations = workWindowRelations(subject.id, selected);
    const section: Section = {
      ok: true,
      read: {
        kind: direction === 'in' ? 'links' : 'relations',
        id: subject.id,
        property: selected.property,
        limit: 20,
      },
      body: { [direction === 'in' ? 'links' : 'relations']: selected.rows },
    };
    const items =
      direction === 'in'
        ? holderItems(section.body, 20, locale, readerSpoiler)
        : statementItems(section, selected.property, 20, value);
    const href = connectionReturnHref(subject.id, value.subjectLabel ?? value.unlabelled, locale, value.realm, {
      stream: `${direction}:${selected.property}`,
    });
    const Link = link;
    const WorkLink: PageLink = (props) => <Link {...props} href={withSubjectVisitReturn(props.href, href, locale)} />;
    return (
      <section
        data-slot="work-franchise"
        aria-labelledby={heading}
        className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      >
        <h2 id={heading} className="text-xl font-semibold">
          {m.work_franchise_title({}, options)}
        </h2>
        {relations && items ? (
          relations.slice(0, 20).map((relation) => {
            const item = items.items.find(
              (item) => item.statement === relation.statement.id && item.id === relation.id,
            );
            const label =
              direction === 'in'
                ? definitions[selected.property]!.label
                : (definitions[selected.property]!.forwardLabel ?? '');
            return item ? (
              <WorkRelation
                key={JSON.stringify([
                  subject.id,
                  subject.context,
                  subject.release,
                  subject.revision,
                  relation,
                  value.reader,
                ])}
                relation={relation}
                item={item}
                value={{ ...value, link: WorkLink }}
                label={label}
                returnHref={href}
              />
            ) : null;
          })
        ) : (
          <p role="status">{m.subject_section_failed({}, options)}</p>
        )}
        {relations?.length === 0 && (
          <p role="status">
            {selected.rows.length
              ? m.subject_relation_unavailable({}, options)
              : m.subject_relation_empty_page({}, options)}
          </p>
        )}
        <Link href={href} className={workLink}>
          {m.subject_connections_title({}, options)}
        </Link>
      </section>
    );
  }
  const destinations = workDestinations(subject, related, definitions);
  if (!destinations.length) return null;
  const Link = link;
  if (value) {
    return (
      <section
        data-slot="work-franchise"
        aria-labelledby={heading}
        className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      >
        <h2 id={heading} className="text-xl font-semibold">
          {m.work_franchise_title({}, options)}
        </h2>
        {destinations.map((destination) => {
          const href = connectionReturnHref(subject.id, value.subjectLabel ?? value.unlabelled, locale, value.realm, {
            stream: `out:${destination.property}`,
          });
          const WorkLink: PageLink = (props) => (
            <Link {...props} href={withSubjectVisitReturn(props.href, href, locale)} />
          );
          const title = pickText(destination.target.labels, locale);
          return (
            <WorkRelation
              key={JSON.stringify([
                subject.id,
                subject.context,
                subject.release,
                subject.revision,
                destination,
                value.reader,
              ])}
              relation={{
                holder: subject.id,
                direction: 'out',
                property: destination.property,
                statement: destination.statement,
                id: destination.id,
                label: title.text,
                kind: destination.kind,
                related,
              }}
              item={{
                id: destination.id,
                label: { text: title.text, lang: title.lang ?? undefined },
                notes: [],
                gated: false,
              }}
              value={{ ...value, link: WorkLink }}
              label={destination.relation.forwardLabel ?? ''}
              returnHref={href}
            />
          );
        })}
        <Link
          href={connectionReturnHref(subject.id, value.subjectLabel ?? value.unlabelled, locale, value.realm)}
          className={workLink}
        >
          {m.subject_connections_title({}, options)}
        </Link>
      </section>
    );
  }

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
                <p className="text-sm text-muted-foreground">
                  {m.work_franchise_relation_label_unavailable({}, options)}
                </p>
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
