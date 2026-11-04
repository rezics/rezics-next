import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader, type Reader } from '../../../subject/reader';
import { CandidateValue } from '../../pages/data';
import { contextHref } from '../../pages/context-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
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
  const reading = useSubjectCommunityReading({
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
      <h2 id={headingId} ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        {m.arc_reader_title({}, o)}
      </h2>
      {reading.available ? (
        <ArcWindow
          key={reading.key}
          {...props}
          settings={settings}
          current={reading.isCurrent}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <p role="status">{m.arc_reader_unavailable({}, o)}</p>
      )}
    </section>
  );
}

type WindowProps = Omit<Props, 'source' | 'reader'> & {
  arc?: string;
  current: () => boolean;
  focusHeading: () => void;
};

/** One replaceable window. Unavailable continuation retains admitted rows and its exact retry address. */
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
  const [page, setPage] = useState<Ready | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<Failure | undefined>(initial && !initial.ok ? initial : undefined);
  const [busy, setBusy] = useState(!initial);
  const [version, setVersion] = useState(0);
  const [member, setMember] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const base: ArcAddress = { id, context, ...(arc ? { arc } : {}) };
  const pending = useRef<ArcAddress>(base);
  const origin = useRef<HTMLAnchorElement | null>(null);
  const memberOrigin = useRef<HTMLButtonElement | null>(null);
  const returnFocus = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!current()) {
      event.preventDefault();
      return;
    }
    if (event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) origin.current = event.currentTarget;
  };
  useEffect(() => {
    const restore = () => {
      const target = origin.current;
      origin.current = null;
      if (!current() || !target) return;
      if (target.isConnected && (document.activeElement === target || document.activeElement === document.body))
        target.focus();
      else if (!target.isConnected && document.activeElement === document.body) focusHeading();
    };
    window.addEventListener('focus', restore);
    return () => window.removeEventListener('focus', restore);
  }, [current, focusHeading]);
  const read = async (address: ArcAddress, trigger?: HTMLButtonElement, keyboard = false) => {
    if (!mounted.current || !current() || inFlight.current) return;
    inFlight.current = true;
    const turn = ++sequence.current;
    pending.current = address;
    setBusy(true);
    setFailure(undefined);
    let result: ArcRead;
    try {
      result = await transport(address);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !current() || sequence.current !== turn) return;
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setPage(result);
      setVersion((value) => value + 1);
      setMember(null);
      if (
        keyboard &&
        trigger &&
        (trigger === document.activeElement || (!trigger.isConnected && document.activeElement === document.body))
      )
        focusHeading();
    } else {
      setFailure(result);
      if (result.reason !== 'unavailable') {
        setPage(undefined);
        setMember(null);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read(base);
    return () => {
      mounted.current = false;
      inFlight.current = false;
      sequence.current++;
      origin.current = null;
    };
  }, []);
  const request = (address: ArcAddress) => (event: MouseEvent<HTMLButtonElement>) => {
    if (!busy) void read(address, event.currentTarget, event.detail === 0);
  };
  const href = (target: string, label: string) => contextHref(subjectHref({ id: target, label }, locale).href, realm);
  const Link: PageLink = (props) => <a {...props} target="_blank" rel="noopener" onClick={returnFocus} />;
  const closeMember = () => {
    setMember(null);
    const trigger = memberOrigin.current;
    if (current() && trigger?.isConnected) trigger.focus();
    else focusHeading();
  };
  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      {!arc && (
        <>
          <p className="text-sm text-muted-foreground">{m.arc_reader_scope({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.arc_reader_return({}, o)}</p>
        </>
      )}
      {busy && <p role="status">{m.candidate_loading({}, o)}</p>}
      {failure && (
        <div role="alert" className="space-y-2">
          <p>
            {failure.reason === 'withheld'
              ? m.arc_reader_withheld({}, o)
              : page
                ? m.arc_reader_next_unavailable({}, o)
                : m.arc_reader_unavailable({}, o)}
          </p>
          <button type="button" className={button} disabled={busy} onClick={request(pending.current)}>
            {m.subject_section_retry({}, o)}
          </button>
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
                type="button"
                className={button}
                aria-pressed={stream.key === page.stream?.key}
                disabled={busy}
                onClick={request({ ...base, stream: stream.key })}
              >
                <span lang={stream.label.lang ?? undefined}>{stream.label.text || stream.property}</span>
                <span className="sr-only">
                  {' '}
                  —{' '}
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
          {!page.caughtUp && <p role="status">{m.work_parts_pending({}, o)}</p>}
          {page.count && (
            <p>
              {m.work_parts_count(
                {
                  accuracy: page.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o),
                  count: page.count.value,
                },
                o,
              )}
            </p>
          )}
          {!page.rows.length && <p role="status">{m.work_parts_empty({}, o)}</p>}
          <ul className="min-w-0 divide-y divide-border">
            {page.rows.map((row) => {
              const summary = row.summary;
              const key = `${version}:${row.holder}:${row.statementId}`;
              if (!row.statement)
                return (
                  <li key={key} className="py-4">
                    {m.arc_reader_withheld({}, o)}
                  </li>
                );
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
                  <ArcEvidence row={row} page={page} locale={locale} link={Link} />
                  {!arc &&
                    page.subject.type === storyArcType &&
                    page.stream?.property === 'rezics:storyArc' &&
                    page.stream.direction === 'inverse' &&
                    summary && (
                      <>
                        <button
                          type="button"
                          className={button}
                          disabled={busy}
                          aria-expanded={member === key}
                          onClick={(event) => {
                            if (!current()) return;
                            memberOrigin.current = event.currentTarget;
                            setMember(member === key ? null : key);
                          }}
                        >
                          {m.arc_reader_characters({}, o)}
                        </button>
                        {member === key && (
                          <MemberAppearances
                            {...{ context, locale, realm, transport, settings, current, closeMember }}
                            id={summary.id}
                            arc={id}
                            label={summary.label?.value ?? ''}
                          />
                        )}
                      </>
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
          <div className="flex flex-wrap gap-3">
            {page.next ? (
              <button
                type="button"
                className={button}
                disabled={busy || !!failure}
                onClick={request({ ...base, stream: page.stream.key, cursor: page.next })}
              >
                {m.work_parts_more({}, o)}
              </button>
            ) : (
              <p role="status">{m.arc_reader_complete({}, o)}</p>
            )}
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={request({ ...base, stream: page.stream.key })}
            >
              {m.work_parts_restart({}, o)}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MemberAppearances(props: Omit<WindowProps, 'focusHeading'> & { label: string; closeMember: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);
  const o = { locale: props.locale as never };
  return (
    <section
      aria-label={m.arc_reader_characters({}, o)}
      className="min-w-0 space-y-4 rounded-lg border border-border p-4"
    >
      <h4 ref={heading} tabIndex={-1} className="font-semibold">
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
