import { useContext, useId, useLayoutEffect, useRef } from 'react';
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
import { workDestinations, workFranchiseGroups, WORK_FRANCHISE_PREVIEW } from './model';
import { workFranchiseReturn, workFranchiseFragment } from '../../catalogue/work-franchise-reading/navigation';

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
  const region = useRef<HTMLElement>(null);
  const incarnation = useRef({ windows, serial: 0 });
  if (incarnation.current.windows !== windows)
    incarnation.current = { windows, serial: incarnation.current.serial + 1 };
  const identity = JSON.stringify([
    subject.id,
    subject.context,
    subject.release,
    subject.revision,
    value?.context,
    value?.reader,
    value?.cacheReader,
    value?.viewer,
    incarnation.current.serial,
  ]);
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.location.pathname.includes(`/subjects/${subject.id}/`)) return;
    const restore = () => {
      const target = workFranchiseReturn(window.location.hash);
      if (!target || target.spoiler !== readerSpoiler) return;
      const row = [...(region.current?.querySelectorAll<HTMLElement>('[data-work-statement]') ?? [])].find(
        (row) =>
          row.dataset.workStatement === target.statement &&
          row.dataset.workHolder === target.holder &&
          row.closest('[data-work-stream]')?.getAttribute('data-work-stream') === target.stream,
      );
      row?.querySelector<HTMLElement>('a, summary, button')?.focus();
    };
    restore();
    window.addEventListener('hashchange', restore);
    return () => window.removeEventListener('hashchange', restore);
  }, [identity, readerSpoiler, subject.id]);
  if (windows !== undefined) {
    const groups = workFranchiseGroups(subject.id, windows, definitions);
    const Link = link;
    return (
      <section
        ref={region}
        data-slot="work-franchise"
        aria-labelledby={heading}
        className="min-w-0 space-y-4 [overflow-wrap:anywhere]"
      >
        <h2 id={heading} className="text-xl font-semibold">
          {m.work_franchise_title({}, options)}
        </h2>
        <p className="text-sm text-muted-foreground">{m.work_franchise_preview_scope({}, options)}</p>
        {!groups.length && <p role="status">{m.work_relations_unsupported({}, options)}</p>}
        {groups.map((group) => {
          const { window, stream } = group;
          const direction = window.direction === 'inverse' ? 'in' : 'out';
          const href = connectionReturnHref(
            subject.id,
            value?.subjectLabel ?? value?.unlabelled ?? '',
            locale,
            value?.realm,
            { stream },
          );
          const section: Section = {
            ok: true,
            read: {
              kind: direction === 'in' ? 'links' : 'relations',
              id: subject.id,
              property: window.property,
              limit: 20,
            },
            body: { [direction === 'in' ? 'links' : 'relations']: window.rows },
          };
          const items =
            value && group.state === 'ready'
              ? direction === 'in'
                ? holderItems(section.body, window.rows.length, locale, readerSpoiler)
                : statementItems(section, window.property, window.rows.length, value)
              : undefined;
          return (
            <section
              key={`${identity}:${window.node}:${stream}`}
              data-work-stream={stream}
              className="min-w-0 space-y-3 rounded-lg border border-border p-3 sm:p-4"
            >
              <h3 className="text-lg font-semibold">
                {group.label || m.work_franchise_relation_label_unavailable({}, options)}
              </h3>
              <p className="text-sm text-muted-foreground">
                {direction === 'in' ? m.subject_connections_in({}, options) : m.subject_connections_out({}, options)}
              </p>
              {group.state === 'unsupported' ? (
                <p role="status">{m.work_franchise_stream_unsupported({}, options)}</p>
              ) : group.state === 'unavailable' || !value ? (
                <p role="status">
                  {window.status === 401 || window.status === 403
                    ? m.work_franchise_stream_refused({}, options)
                    : window.status === 404
                      ? m.work_franchise_stream_concealed({}, options)
                      : m.subject_relation_unavailable({}, options)}
                </p>
              ) : group.state === 'concealed' ? (
                <p role="status">{m.work_franchise_stream_concealed({}, options)}</p>
              ) : group.state === 'empty' ? (
                <p role="status">{m.subject_relation_empty_page({}, options)}</p>
              ) : null}
              {value &&
                group.preview.map((relation) => {
                  const item = items?.items.find(
                    (item) => item.statement === relation.statement.id && item.id === relation.id,
                  );
                  if (!item) return null;
                  const rowReturn = `${returnTo.split('#')[0]}${workFranchiseFragment({
                    stream,
                    statement: relation.statement.id,
                    holder: relation.holder,
                    spoiler: readerSpoiler,
                  })}`;
                  const WorkLink: PageLink = (props) => (
                    <Link {...props} href={withSubjectVisitReturn(props.href, rowReturn, locale)} />
                  );
                  return (
                    <WorkRelation
                      key={JSON.stringify([relation.holder, relation.statement.id, relation])}
                      relation={relation}
                      item={item}
                      value={{ ...value, link: WorkLink }}
                      label={group.label!}
                      returnHref={rowReturn}
                      connectionsHref={href}
                    />
                  );
                })}
              {group.unavailable && <p role="status">{m.subject_relation_unavailable({}, options)}</p>}
              {group.more && <p role="status">{m.work_franchise_preview_more({}, options)}</p>}
              <Link href={href} className={workLink}>
                {m.subject_connections_title({}, options)}
              </Link>
            </section>
          );
        })}
      </section>
    );
  }
  const destinations = workDestinations(subject, related, definitions).slice(0, WORK_FRANCHISE_PREVIEW.total);
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
