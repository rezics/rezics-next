import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader, type Reader } from '../../../subject/reader';
import { CandidateValue } from '../../pages/data';
import { contextHref } from '../../pages/context-navigation';
import { addressLease, type AddressLease } from '../../../reader/lease';
import { useArcLifetime } from './reading/use-lifetime';
import { useArcWindow } from './reading/use-window';
import { linkClass, linkColor, spoilerLevel, type PageLink } from '../../pages/shared';
import { SpoilerGate } from '../../pages/values';
import type { PartRow } from '../work-parts';
import { storyArcType } from '../story-arc-profile';
import type { ArcAddress, ArcRead, ArcTransport } from './model';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const button = `${buttonVariants({ variant: 'outline' })} ${action}`;
const linkClassName = `${action} ${linkClass} ${linkColor} underline`;
type Ready = Extract<ArcRead, { ok: true }>;
type Failure = Extract<ArcRead, { ok: false }>;
type Props = {
  id: string;
  context: string;
  locale: string;
  realm?: string | undefined;
  transport: ArcTransport;
  source: object | string;
  reader: string | null;
  settings?: Reader | undefined;
  initial?: ArcRead;
};

export function StoryArcReader(props: Props) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const settings = props.settings ?? defaultReader;
  const reading = useArcLifetime({
    source: props.source,
    reader: props.reader,
    descriptor: JSON.stringify([
      props.id,
      props.context,
      props.locale,
      props.realm,
      settings.spoilerLevel,
      settings.suitability,
    ]),
  });
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [reading.key, reading.available]);
  const o = { locale: props.locale as never };
  return (
    <section
      data-slot="story-arc-reader"
      aria-labelledby={headingId}
      className="min-w-0 space-y-4"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.arc_reader_title({}, o)}
      </h2>
      {reading.available ? (
        <ArcWindow
          key={reading.key}
          {...props}
          settings={settings}
          current={reading.current}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <div className="space-y-3" role="status">
          <p>{m.arc_reader_unavailable({}, o)}</p>
          <SubjectRecovery {...props} />
        </div>
      )}
    </section>
  );
}

function SubjectRecovery({ id, locale, realm }: Pick<Props, 'id' | 'locale' | 'realm'>) {
  return (
    <a className={linkClassName} href={contextHref(subjectHref({ id, label: '' }, locale).href, realm)}>
      {m.arc_reader_fresh_subject({}, { locale: locale as never })}
    </a>
  );
}

type WindowProps = Omit<Props, 'source' | 'reader'> & {
  arc?: string;
  current: () => boolean;
  focusHeading: () => void;
};
type Member = {
  key: string;
  id: string;
  label: string;
  trigger: HTMLButtonElement;
  keyboard: boolean;
  lease: AddressLease;
};

/** Local selection belongs to one accepted page episode, including equal-success replacement. */
function ArcWindow({
  id,
  context,
  locale,
  realm,
  transport,
  settings = defaultReader,
  initial,
  arc,
  current,
  focusHeading,
}: WindowProps) {
  const o = { locale: locale as never };
  const [selected, setSelected] = useState<string | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const memberRef = useRef<Member | null>(null);
  const origin = useRef<{ target: HTMLAnchorElement; lease: AddressLease } | null>(null);
  const focusAfter = useRef<Element | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const beforeReplace = () => {
    // Restore only focus which actually belonged to removed content; later interaction cancels it.
    const active = document.activeElement;
    focusAfter.current = active && container.current?.contains(active) ? active : null;
    memberRef.current?.lease.retire();
    memberRef.current = null;
    origin.current = null;
    setMember(null);
    setSelected(null);
  };
  const base: ArcAddress = { id, context, ...(arc ? { arc } : {}) };
  const windowRead = useArcWindow({ base, initial, transport, current, beforeReplace });
  const { page, failure, busy, version, episode } = windowRead;
  const isCurrent = () => current() && episode.current();
  useLayoutEffect(() => {
    const removed = focusAfter.current;
    focusAfter.current = null;
    if (removed && !removed.isConnected && document.activeElement === document.body && isCurrent()) focusHeading();
  }, [version, page, member]);
  useEffect(() => {
    const restore = () => {
      const intent = origin.current;
      origin.current = null;
      if (!intent || !current() || !intent.lease.current()) return;
      if (
        intent.target.isConnected &&
        (document.activeElement === intent.target || document.activeElement === document.body)
      )
        intent.target.focus();
      else if (!intent.target.isConnected && document.activeElement === document.body) focusHeading();
    };
    const cancel = (event: Event) => {
      if (origin.current && event.target !== origin.current.target && event.target !== document.body)
        origin.current = null;
    };
    window.addEventListener('focus', restore);
    document.addEventListener('focusin', cancel);
    document.addEventListener('pointerdown', cancel);
    return () => {
      window.removeEventListener('focus', restore);
      document.removeEventListener('focusin', cancel);
      document.removeEventListener('pointerdown', cancel);
      origin.current = null;
    };
  }, [current, focusHeading]);
  const returnFocus = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isCurrent()) {
      event.preventDefault();
      return;
    }
    if (event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey)
      origin.current = { target: event.currentTarget, lease: episode };
  };
  const Link: PageLink = (props) => <a {...props} target="_blank" rel="noopener" onClick={returnFocus} />;
  const href = (target: string, label: string) => contextHref(subjectHref({ id: target, label }, locale).href, realm);
  const operate = (operation: () => Promise<void> | undefined) => (event: MouseEvent<HTMLButtonElement>) => {
    if (!isCurrent() || busy) return;
    void operation();
  };
  const closeMember = (opened: Member) => {
    // A callback from a removed child must neither close the new child nor use an old heading fallback.
    if (!current() || memberRef.current !== opened || !opened.lease.current()) return;
    opened.lease.retire();
    memberRef.current = null;
    setMember(null);
    if (opened.trigger.isConnected) opened.trigger.focus();
    else focusHeading();
  };
  const inspect = (key: string) => {
    if (!isCurrent()) return;
    memberRef.current?.lease.retire();
    memberRef.current = null;
    setMember(null);
    setSelected((value) => (value === key ? null : key));
  };
  const openMember = (key: string, row: PartRow, event: MouseEvent<HTMLButtonElement>) => {
    if (!isCurrent() || busy || !row.summary) return;
    if (memberRef.current?.key === key) {
      closeMember(memberRef.current);
      return;
    }
    memberRef.current?.lease.retire();
    const opened: Member = {
      key,
      id: row.summary.id,
      label: row.summary.label?.value ?? '',
      trigger: event.currentTarget,
      keyboard: event.detail === 0,
      lease: addressLease(() => current() && episode.current()),
    };
    memberRef.current = opened;
    setSelected(key);
    setMember(opened);
  };
  return (
    <div
      ref={container}
      className="min-w-0 space-y-4"
      aria-busy={busy}
      data-slot={arc ? 'arc-appearance-window' : 'arc-outer-window'}
    >
      {!arc && (
        <>
          <p className="text-sm text-muted-foreground">{m.arc_reader_scope({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.arc_reader_return({}, o)}</p>
        </>
      )}
      {arc && <p className="text-sm text-muted-foreground">{m.arc_reader_appearances({}, o)}</p>}
      {busy && <p role="status">{m.candidate_loading({}, o)}</p>}
      {failure && (
        <div role="alert" className="space-y-3 rounded-lg border border-border p-4">
          <p>
            {failure.reason === 'withheld'
              ? m.arc_reader_withheld({}, o)
              : failure.reason === 'invalid'
                ? m.arc_reader_invalid({}, o)
                : page
                  ? m.arc_reader_next_unavailable({}, o)
                  : m.arc_reader_unavailable({}, o)}
          </p>
          {windowRead.pending && <Address address={windowRead.pending.address} locale={locale} failed />}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={button} disabled={busy} onClick={operate(windowRead.retry)}>
              {m.subject_section_retry({}, o)}
            </button>
            <button type="button" className={button} disabled={busy} onClick={operate(windowRead.discover)}>
              {m.arc_reader_discover({}, o)}
            </button>
            <SubjectRecovery {...{ id, locale, realm }} />
          </div>
        </div>
      )}
      {page && !page.stream && <p role="status">{m.arc_reader_unsupported({}, o)}</p>}
      {page && (
        <a
          className={linkClassName}
          href={contextHref(`${subjectHref({ id, label: page.subject.label.text }, locale).href}/details`, realm)}
          target="_blank"
          rel="noopener"
          onClick={returnFocus}
        >
          {m.subject_details({}, o)}
        </a>
      )}
      {page?.stream && (
        <>
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label={m.work_parts_relation({}, o)}>
            {page.streams.map((stream) => (
              <button
                key={stream.key}
                data-stream={stream.key}
                type="button"
                className={button}
                aria-pressed={stream.key === page.stream?.key}
                disabled={busy}
                onClick={operate(() => windowRead.select(stream.key))}
              >
                <span lang={stream.label.lang ?? undefined}>{stream.label.text || stream.property}</span>
                <span className="ml-2 text-sm">
                  {stream.kind === 'sequence'
                    ? m.arc_reader_sequence_label({}, o)
                    : stream.kind === 'appearance'
                      ? m.arc_reader_appearance_label({}, o)
                      : m.arc_reader_membership_label({}, o)}
                  {' · '}
                  {stream.direction === 'forward'
                    ? m.character_relationships_direction_forward({}, o)
                    : m.character_relationships_direction_inverse({}, o)}
                </span>
              </button>
            ))}
          </nav>
          <p className="text-sm text-muted-foreground">
            {page.stream.kind === 'sequence'
              ? m.arc_reader_sequence({}, o)
              : page.stream.kind === 'appearance'
                ? m.arc_reader_appearances({}, o)
                : m.arc_reader_membership({}, o)}
          </p>
          <div className="min-w-0 space-y-2 rounded-lg bg-muted p-4" aria-live="polite">
            <p>{failure ? m.arc_reader_prior_page({}, o) : m.arc_reader_current_page({}, o)}</p>
            {windowRead.accepted && <Address address={windowRead.accepted.address} locale={locale} />}
            <p>{page.caughtUp ? m.arc_reader_caught_up({}, o) : m.work_parts_pending({}, o)}</p>
            {page.count ? (
              <p>
                {m.work_parts_count(
                  {
                    accuracy: page.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o),
                    count: page.count.value,
                  },
                  o,
                )}
              </p>
            ) : (
              <p>{m.arc_reader_count_unknown({}, o)}</p>
            )}
          </div>
          {!page.rows.length && <p role="status">{m.work_parts_empty({}, o)}</p>}
          <ul className="min-w-0 divide-y divide-border">
            {page.rows.map((row) => {
              const key = `${version}:${row.holder}:${row.statementId}`;
              if (!row.statement)
                return (
                  <li key={key} className="py-4">
                    {m.arc_reader_withheld({}, o)}
                  </li>
                );
              const summary = row.summary;
              const inspected = selected === key;
              const memberWork =
                !arc &&
                page.subject.type === storyArcType &&
                page.stream?.property === 'rezics:storyArc' &&
                page.stream.direction === 'inverse' &&
                summary;
              const content = (
                <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
                  <h3 className="font-semibold" lang={summary?.label?.language}>
                    {summary?.label?.value || m.work_parts_unresolved({}, o)}
                  </h3>
                  {summary && (
                    <a
                      className={linkClassName}
                      href={href(summary.id, summary.label?.value ?? '')}
                      target="_blank"
                      rel="noopener"
                      onClick={returnFocus}
                    >
                      {m.arc_reader_open({}, o)}
                    </a>
                  )}
                  {row.statement.value.type !== 'value' && (
                    <CandidateValue snak={row.statement} related={row.related} locale={locale} link={Link} />
                  )}
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={button}
                      aria-expanded={inspected}
                      disabled={busy}
                      onClick={() => inspect(key)}
                    >
                      {m.arc_reader_inspect({}, o)}
                    </button>
                    {memberWork && (
                      <button
                        type="button"
                        className={button}
                        disabled={busy}
                        aria-expanded={member?.key === key}
                        onClick={(event) => openMember(key, row, event)}
                      >
                        {m.arc_reader_characters({}, o)}
                      </button>
                    )}
                  </div>
                  {inspected && (
                    <section
                      aria-label={m.arc_reader_inspect({}, o)}
                      className="min-w-0 space-y-3 rounded-lg border border-border p-4"
                    >
                      <p className="text-sm text-muted-foreground">{m.arc_reader_evidence_scope({}, o)}</p>
                      <ArcEvidence {...{ row, page, locale }} link={Link} />
                    </section>
                  )}
                  {member?.key === key && (
                    <MemberAppearances
                      key={key}
                      {...{ context, locale, realm, transport, settings }}
                      id={member.id}
                      arc={id}
                      label={member.label}
                      current={member.lease.current}
                      opened={member}
                      closeMember={() => closeMember(member)}
                      onRetire={() => {
                        if (memberRef.current !== member) return;
                        memberRef.current = null;
                        setMember(null);
                      }}
                    />
                  )}
                </div>
              );
              return (
                <li key={key} data-slot="story-arc-row" className="min-w-0 py-4">
                  {spoilerLevel(row.statement) > settings.spoilerLevel ? (
                    <SpoilerGate label={m.subject_spoiler_show({}, o)} hideLabel={m.subject_spoiler_hide({}, o)}>
                      {content}
                    </SpoilerGate>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
          <nav className="flex flex-wrap items-center gap-3" aria-label={m.arc_reader_pages({}, o)}>
            <button
              type="button"
              className={button}
              disabled={busy || !windowRead.previous}
              onClick={operate(windowRead.back)}
            >
              {m.arc_reader_previous({}, o)}
            </button>
            {page.next ? (
              <button type="button" className={button} disabled={busy || !!failure} onClick={operate(windowRead.more)}>
                {m.work_parts_more({}, o)}
              </button>
            ) : (
              !failure && <p role="status">{m.arc_reader_complete({}, o)}</p>
            )}
            <button type="button" className={button} disabled={busy} onClick={operate(windowRead.start)}>
              {m.work_parts_restart({}, o)}
            </button>
          </nav>
          {windowRead.evicted && <p className="text-sm text-muted-foreground">{m.arc_reader_history_limit({}, o)}</p>}
        </>
      )}
      {page && !failure && !page.stream && (
        <button type="button" className={button} disabled={busy} onClick={operate(windowRead.discover)}>
          {m.arc_reader_discover({}, o)}
        </button>
      )}
    </div>
  );
}

function Address({ address, locale, failed = false }: { address: ArcAddress; locale: string; failed?: boolean }) {
  const o = { locale: locale as never };
  return (
    <details className="min-w-0 text-sm [overflow-wrap:anywhere]">
      <summary className={`${action} cursor-pointer`}>
        {failed ? m.arc_reader_failed_address({}, o) : m.arc_reader_page_address({}, o)}
      </summary>
      <dl className="space-y-1">
        <dt>{m.work_parts_holder({}, o)}</dt>
        <dd>{address.id}</dd>
        <dt>{m.work_parts_relation({}, o)}</dt>
        <dd>{address.stream ?? m.arc_reader_discover({}, o)}</dd>
        <dt>{m.arc_reader_page_address({}, o)}</dt>
        <dd>{address.cursor ?? m.arc_reader_start_address({}, o)}</dd>
        {address.arc && (
          <>
            <dt>{m.arc_reader_arc_filter({}, o)}</dt>
            <dd>{address.arc}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function MemberAppearances(
  props: Omit<WindowProps, 'focusHeading'> & {
    label: string;
    opened: Member;
    closeMember: () => void;
    onRetire: () => void;
  },
) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (props.opened.keyboard && props.current() && document.activeElement === props.opened.trigger)
      heading.current?.focus();
    return () => {
      props.opened.lease.retire();
      props.onRetire();
    };
  }, []);
  const o = { locale: props.locale as never };
  return (
    <section
      aria-label={m.arc_reader_characters({}, o)}
      className="min-w-0 space-y-4 rounded-lg border border-border p-4"
    >
      <h4 ref={heading} tabIndex={-1} className="font-semibold focus-visible:outline-2 focus-visible:outline-ring">
        {props.label}
      </h4>
      <button type="button" className={button} onClick={props.closeMember}>
        {m.arc_reader_back({}, o)}
      </button>
      <ArcWindow {...props} focusHeading={() => heading.current?.focus()} />
    </section>
  );
}

function ArcEvidence({ row, page, locale, link }: { row: PartRow; page: Ready; locale: string; link: PageLink }) {
  const o = { locale: locale as never };
  const snaks = (values: NonNullable<PartRow['statement']>['qualifiers']): ReactNode => (
    <dl className="space-y-2">
      {values.map((snak, index) => (
        <div key={index}>
          <dt className="text-sm text-muted-foreground" lang={page.labels[snak.property.id]?.lang ?? undefined}>
            {page.labels[snak.property.id]?.text || snak.property.id}
          </dt>
          <dd>
            <CandidateValue snak={snak} related={row.related} locale={locale} link={link} />
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <>
      {snaks(row.statement?.qualifiers ?? [])}
      <details className="min-w-0 rounded-lg border border-border p-3">
        <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
        {row.statement?.references.length ? (
          row.statement.references.map((reference, index) => (
            <div key={index} className="mt-3">
              {snaks(reference.parts)}
            </div>
          ))
        ) : (
          <p>{m.own_drafts_no_references({}, o)}</p>
        )}
      </details>
      <details className="min-w-0 rounded-lg border border-border p-3 text-sm">
        <summary className={`${action} cursor-pointer`}>{m.catalogue_technical_details({}, o)}</summary>
        <dl className="space-y-2">
          <dt>{m.work_parts_holder({}, o)}</dt>
          <dd>{row.holder}</dd>
          <dt>{m.work_parts_relation({}, o)}</dt>
          <dd>{page.stream?.property}</dd>
          <dt>{m.arc_reader_direction({}, o)}</dt>
          <dd>
            {page.stream?.direction === 'forward'
              ? m.character_relationships_direction_forward({}, o)
              : m.character_relationships_direction_inverse({}, o)}
          </dd>
          <dt>{m.arc_reader_statement({}, o)}</dt>
          <dd>{row.statementId}</dd>
          {row.summary && (
            <>
              <dt>{m.arc_reader_target({}, o)}</dt>
              <dd>{row.summary.id}</dd>
            </>
          )}
        </dl>
      </details>
    </>
  );
}
