import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref, subjectUrlForView } from '../../../subject/subject-href';
import { CandidateValue } from '../../pages/data';
import { contextHref } from '../../pages/context-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { spoilerLevel } from '../../pages/shared';
import { SpoilerGate } from '../../pages/values';
import { historicalStatement } from '../release-fidelity/model';
import { gameDatePresentation } from './date';
import { profileSourceRecords } from '../music-reader';
import type { GameReaderAddress, GameReaderRead, GameReaderReady, GameReaderTransport, GameStatement } from './model';

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass = `${action} text-primary underline underline-offset-4`;
type Props = GameReaderAddress & {
  locale: string;
  realm?: string | undefined;
  source: object | string;
  reader: string | null;
  spoiler?: number | undefined;
  transport: GameReaderTransport;
  initial?: GameReaderRead;
};

/** Source and authority replacement retire the entire window, its cursors, reveal consent and focus intent. */
export function GameReader(props: Props) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const reading = useSubjectCommunityReading({
    source: props.source,
    reader: props.reader,
    descriptor: JSON.stringify([props.id, props.context, props.type, props.locale, props.realm, props.spoiler]),
  });
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [reading.key, reading.available]);
  const o = { locale: props.locale as never };
  return (
    <section
      data-slot="game-reader"
      aria-labelledby={id}
      className="min-w-0 space-y-4 [overflow-wrap:anywhere]"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2 id={id} ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {m.game_reader_title({}, o)}
      </h2>
      {reading.available ? (
        <GameWindow
          key={reading.key}
          {...props}
          current={reading.isCurrent}
          focusHeading={() => heading.current?.focus()}
        />
      ) : (
        <p role="status">{m.game_reader_unavailable({}, o)}</p>
      )}
    </section>
  );
}

function GameWindow({
  id,
  context,
  type,
  locale,
  realm,
  spoiler = 0,
  transport,
  initial,
  current,
  focusHeading,
}: Props & { current: () => boolean; focusHeading: () => void }) {
  const o = { locale: locale as never };
  const [page, setPage] = useState<GameReaderReady | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<GameReaderRead | undefined>(initial && !initial.ok ? initial : undefined);
  const [busy, setBusy] = useState(!initial);
  const mounted = useRef(false);
  const pending = useRef<GameReaderAddress>({ id, context, type });
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const acceptedCursors = useRef(new Set<string>());
  const successfulWindows = useRef(initial?.ok ? 1 : 0);
  const origin = useRef<HTMLAnchorElement | null>(null);
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
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
  const read = async (address: GameReaderAddress, trigger?: HTMLButtonElement, keyboard = false) => {
    if (!mounted.current || !current() || inFlight.current) return;
    inFlight.current = true;
    pending.current = address;
    const turn = ++sequence.current;
    // A continuation replaces only its bounded release window. Keep the work reading available
    // while the new window loads or its transport fails; never retain the old release destinations.
    setPage((previous) => (address.cursor && previous ? { ...previous, editions: [], next: null } : undefined));
    setFailure(undefined);
    if (address.cursor && (acceptedCursors.current.has(address.cursor) || successfulWindows.current >= 64)) {
      inFlight.current = false;
      setBusy(false);
      setFailure({ ok: false, reason: 'restart' });
      return;
    }
    if (!address.cursor) {
      acceptedCursors.current.clear();
      successfulWindows.current = 0;
    }
    setBusy(true);
    let result: GameReaderRead;
    try {
      result = await transport(address);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !current() || turn !== sequence.current) return;
    inFlight.current = false;
    setBusy(false);
    if (
      result.ok &&
      result.public.subject.id === id &&
      result.public.subject.context === context &&
      result.public.subject.type === type
    ) {
      successfulWindows.current++;
      if (address.cursor) acceptedCursors.current.add(address.cursor);
      setPage(result);
    } else {
      const refused = result.ok || result.reason === 'withheld' || result.reason === 'invalid';
      if (refused) setPage(undefined);
      setFailure(result.ok ? { ok: false, reason: 'withheld' } : result);
    }
    if (
      keyboard &&
      trigger &&
      (document.activeElement === trigger || (!trigger.isConnected && document.activeElement === document.body))
    )
      focusHeading();
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read({ id, context, type });
    return () => {
      mounted.current = false;
      inFlight.current = false;
      sequence.current++;
      origin.current = null;
    };
  }, []);
  const request = (address: GameReaderAddress) => (event: MouseEvent<HTMLButtonElement>) => {
    void read(address, event.currentTarget, event.detail === 0);
  };
  const Link = (props: ComponentProps<'a'>) => (
    <a
      {...props}
      href={contextHref(props.href ?? '', realm)}
      className={linkClass}
      target="_blank"
      rel="noopener"
      onClick={navigate}
    />
  );
  const label = page ? pickText(page.public.subject.labels, locale) : undefined;
  const base = subjectHref({ id, label: label?.text ?? '' }, locale);
  const groups = {
    facts: m.game_profile_facts({}, o),
    classification: m.game_profile_classification({}, o),
    credits: m.game_profile_credits({}, o),
    relations: m.game_profile_relations({}, o),
  };
  const unsupported = {
    platform: m.game_reader_platform({}, o),
    engine: m.game_reader_engine({}, o),
    language: m.game_reader_language({}, o),
    status: m.game_reader_status({}, o),
  };
  const gate = (statement: GameStatement, body: ReactNode) =>
    spoilerLevel(statement) > spoiler ? (
      <SpoilerGate label={m.thread_reveal_spoiler({}, o)} hideLabel={m.subject_spoiler_hide({}, o)}>
        {body}
      </SpoilerGate>
    ) : (
      body
    );
  const failureNotice =
    failure && !failure.ok ? (
      <div role="alert">
        <p>
          {failure.reason === 'restart'
            ? m.game_reader_window_restart({}, o)
            : failure.reason === 'withheld'
              ? m.game_reader_withheld({}, o)
              : m.game_reader_unavailable({}, o)}
        </p>
        <button
          type="button"
          className={`${buttonVariants({ variant: 'outline' })} ${action}`}
          disabled={busy}
          onClick={request(failure.reason === 'restart' ? { id, context, type } : pending.current)}
        >
          {failure.reason === 'restart' ? m.game_reader_refresh({}, o) : m.album_tracks_retry({}, o)}
        </button>
      </div>
    ) : null;
  return (
    <div className="min-w-0 space-y-5" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{m.game_reader_scope({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.game_reader_return({}, o)}</p>
      {busy && !page ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {!page ? failureNotice : null}
      {page ? (
        <>
          <p>
            <span lang={page.grain.lang ?? undefined}>{page.grain.text}</span> ·{' '}
            <span lang={label?.lang ?? undefined}>{label?.text}</span>
          </p>
          {!page.admitted ? (
            <p role="status">{m.game_reader_unsupported({}, o)}</p>
          ) : (
            <>
              {page.unsupported.length ? (
                <p role="status">
                  {m.game_reader_missing({ fields: page.unsupported.map((kind) => unsupported[kind]).join(', ') }, o)}
                </p>
              ) : null}
              {!page.groups.length ? <p>{m.game_reader_empty({}, o)}</p> : null}
              {page.groups.map((group) => (
                <section key={group.id} className="space-y-3">
                  <h3 className="font-semibold">{groups[group.id]}</h3>
                  <dl className="space-y-4">
                    {group.fields.map((field) => (
                      <div key={field.property}>
                        <dt className="font-medium" lang={field.label.lang ?? undefined}>
                          {field.label.text || field.property}
                        </dt>
                        <dd className="space-y-3">
                          {!field.statements.length ? <p>{m.release_fidelity_date_absent({}, o)}</p> : null}
                          {field.statements.map((statement) => (
                            <div key={statement.id}>
                              {gate(
                                statement,
                                <GameFact
                                  statement={statement}
                                  page={page}
                                  related={page.public.related}
                                  locale={locale}
                                  date={field.date}
                                  link={Link}
                                />,
                              )}
                            </div>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              <section className="space-y-3" data-slot="game-editions">
                <h3 className="font-semibold">{m.subject_editions({}, o)}</h3>
                <p>{m.game_reader_editions_scope({}, o)}</p>
                {busy ? (
                  <p role="status">{m.candidate_loading({}, o)}</p>
                ) : failure ? (
                  failureNotice
                ) : !page.editionsAdmitted ? (
                  <p role="status">{m.game_reader_editions_unsupported({}, o)}</p>
                ) : (
                  <>
                    {!page.editions.length ? <p>{m.game_reader_editions_empty({}, o)}</p> : null}
                    <ul className="space-y-4">
                      {page.editions.map((row) => {
                        const summary = row.summary;
                        const title = summary?.label;
                        const statement = row.assertion;
                        const related = Object.fromEntries(
                          Object.entries(row.related ?? {}).map(([key, item]) => [
                            key,
                            {
                              type: item.type,
                              labels: item.label ? { [item.label.language]: item.label.value } : {},
                            },
                          ]),
                        );
                        const body = (
                          <>
                            {summary && title?.value && statement && page.editionTypes.includes(summary.type) ? (
                              <>
                                <p lang={title.language}>{title.value}</p>
                                <div className="flex flex-wrap gap-x-4">
                                  <Link href={subjectHref({ id: summary.id, label: title.value }, locale).href}>
                                    {m.game_reader_open({}, o)}
                                  </Link>
                                  <Link
                                    href={subjectUrlForView(
                                      subjectHref({ id: summary.id, label: title.value }, locale),
                                      'release',
                                    )}
                                  >
                                    {m.game_reader_release_detail({}, o)}
                                  </Link>
                                </div>
                              </>
                            ) : (
                              <p>{m.work_parts_unresolved({}, o)}</p>
                            )}
                            {statement ? (
                              <GameEvidence
                                statement={statement}
                                page={page}
                                related={related}
                                locale={locale}
                                link={Link}
                              />
                            ) : null}
                          </>
                        );
                        return (
                          <li
                            key={`${row.subject}:${row.statement}`}
                            className="min-w-0 rounded-lg border border-border p-3"
                          >
                            {statement ? gate(statement, body) : body}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-sm text-muted-foreground">{m.game_reader_total_unknown({}, o)}</p>
                    <p className="text-sm text-muted-foreground">
                      {page.next
                        ? m.game_reader_more_available({}, o)
                        : page.caughtUp
                          ? m.game_reader_window_complete({}, o)
                          : m.work_parts_pending({}, o)}
                    </p>
                    {!page.caughtUp && page.next ? <p role="status">{m.work_parts_pending({}, o)}</p> : null}
                    {page.next ? (
                      <button
                        type="button"
                        className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                        disabled={busy}
                        onClick={request({ id, context, type, cursor: page.next })}
                      >
                        {m.work_parts_more({}, o)}
                      </button>
                    ) : null}
                  </>
                )}
              </section>
            </>
          )}
          <section className="space-y-2">
            <h3 className="font-semibold">{m.music_reader_source_evidence({}, o)}</h3>
            <p>{m.music_reader_source_editorial({}, o)}</p>
            <ul>
              {profileSourceRecords(page.public.subject).map((source, index) => (
                <li key={index}>
                  {/^https?:\/\//.test(source.url) ? <Link href={source.url}>{source.name}</Link> : source.name}
                  {source.attribution ? <p>{source.attribution}</p> : null}
                  {source.licence ? <p>{source.licence.id}</p> : null}
                </li>
              ))}
            </ul>
          </section>
          <nav className="flex flex-wrap gap-x-4" aria-label={m.game_reader_fallback({}, o)}>
            <Link href={subjectUrlForView(base, 'details')}>{m.game_reader_fallback({}, o)}</Link>
            <Link href={subjectUrlForView(base, 'edit')}>{m.facts_title({}, o)}</Link>
            {page.admitted ? <Link href={subjectUrlForView(base, 'game')}>{m.game_reader_correct({}, o)}</Link> : null}
            <Link href={subjectUrlForView(base, 'relations')}>{m.subject_relations({}, o)}</Link>
          </nav>
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={request({ id, context, type })}
          >
            {m.game_reader_refresh({}, o)}
          </button>
        </>
      ) : null}
    </div>
  );
}

type FactProps = {
  statement: GameStatement;
  page: GameReaderReady;
  related: SubjectRead['related'];
  locale: string;
  link: typeof import('../../pages/shared').PlainLink;
};
function GameFact(props: FactProps & { date: boolean }) {
  const { statement, page, related, locale, link: Link } = props;
  const o = { locale: locale as never };
  const date = props.date ? gameDatePresentation(statement, page.digest, locale) : undefined;
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  return (
    <div className="space-y-2">
      {date ? (
        <p data-date-kind={date.kind}>
          {date.structuredDate ? <time dateTime={date.structuredDate}>{date.text}</time> : date.text}
        </p>
      ) : statement.property.data_type === 'wikibase-item' &&
        typeof content === 'string' &&
        !pickText(related[content]?.labels ?? {}, locale).text ? (
        <p>{m.work_parts_unresolved({}, o)}</p>
      ) : (
        <CandidateValue snak={statement} related={related} locale={locale} link={Link} />
      )}
      <GameEvidence {...props} />
    </div>
  );
}

function GameEvidence({ statement, page, related, locale, link: Link }: FactProps) {
  const o = { locale: locale as never };
  return (
    <div className="space-y-2">
      {statement.qualifiers.length ? (
        <dl className="space-y-1 text-sm">
          {statement.qualifiers.map((part, index) => (
            <div key={index}>
              <dt className="font-medium" lang={page.labels[part.property.id]?.lang ?? undefined}>
                {page.labels[part.property.id]?.text || part.property.id}
              </dt>
              <dd>
                <CandidateValue snak={part} related={related} locale={locale} link={Link} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {historicalStatement(statement, page.digest) ? (
        <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
      ) : null}
      <details className="rounded-lg border border-border p-3">
        <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
        {statement.references.map((reference, index) => (
          <dl key={index} className="space-y-1">
            {reference.parts.map((part, n) => (
              <div key={n}>
                <dt className="font-medium">{page.labels[part.property.id]?.text || part.property.id}</dt>
                <dd>
                  <CandidateValue snak={part} related={related} locale={locale} link={Link} />
                </dd>
              </div>
            ))}
          </dl>
        ))}
        <p className="text-sm">
          {statement.id} · {statement.rank} · {statement.rezics.release}
        </p>
      </details>
    </div>
  );
}
