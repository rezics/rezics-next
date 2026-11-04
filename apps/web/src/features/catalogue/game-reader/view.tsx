import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type MouseEvent,
} from 'react';
import { pickText } from '@rezics/composition';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { subjectHref, subjectUrlForView } from '../../../subject/subject-href';
import { contextHref } from '../../pages/context-navigation';
import type { SubjectRead } from '@rezics/client';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { spoilerLevel } from '../../pages/shared';
import { SpoilerGate } from '../../pages/values';
import { profileSourceRecords } from '../music-reader';
import type { GameReaderAddress, GameReaderRead, GameReaderReady, GameReaderTransport, GameStatement } from './model';

import { action, linkClass } from './reading/controls';
import { GameFact, GameEvidence } from './reading/evidence';
import { useEditionWindow } from './reading/window';
import { useReaderFocus } from './reading/focus';
import { EditionInspection, type EditionSelection } from './reading/edition';
import { RetiredReading, SafeNavigation } from './reading/recovery';

type Props = GameReaderAddress & {
  locale: string;
  realm?: string | undefined;
  source: object | string;
  reader: string | null;
  spoiler?: number | undefined;
  transport: GameReaderTransport;
  initial?: GameReaderRead;
  refresh?: () => Promise<void>;
};

/** Source and authority replacement retire the entire window, its cursors, reveal consent and focus intent. */
export function GameReader(props: Props) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const section = useRef<HTMLElement>(null);
  const keyboard = useRef(true);
  useEffect(() => {
    const pointer = () => {
      keyboard.current = false;
      focused.current = null;
    };
    const key = () => {
      keyboard.current = true;
      focused.current = section.current?.contains(document.activeElement) ? document.activeElement : null;
    };
    const moved = (event: FocusEvent) => {
      if (!section.current?.contains(event.target as Node)) focused.current = null;
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', moved, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', moved, true);
    };
  }, []);
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
      ref={section}
      data-slot="game-reader"
      aria-labelledby={id}
      className="min-w-0 space-y-4 [overflow-wrap:anywhere]"
      onFocusCapture={(event) => {
        focused.current = keyboard.current ? event.target : null;
      }}
    >
      <h2
        id={id}
        ref={heading}
        tabIndex={-1}
        className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
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
        <RetiredReading {...props} />
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
  const [selected, setSelected] = useState<EditionSelection | undefined>(undefined);
  const focus = useReaderFocus(current, focusHeading);
  const window = useEditionWindow({
    address: { id, context, type },
    initial,
    transport,
    current,
    replaced: () => {
      setSelected(undefined);
      focus.clearDestination();
    },
  });
  const { page, failure, busy } = window;
  const request = (operation: () => Promise<boolean>) => (event: MouseEvent<HTMLButtonElement>) => {
    void focus.request(event, operation);
  };
  const Link = (props: ComponentProps<'a'>) => (
    <a
      {...props}
      href={contextHref(props.href ?? '', realm)}
      className={linkClass}
      target="_blank"
      rel="noopener"
      onClick={focus.navigate}
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
              : failure.reason === 'invalid'
                ? m.game_reader_invalid({}, o)
                : m.game_reader_unavailable({}, o)}
        </p>
        <button
          type="button"
          className={`${buttonVariants({ variant: 'outline' })} ${action}`}
          disabled={busy}
          onClick={request(failure.reason === 'restart' ? window.start : window.retry)}
        >
          {failure.reason === 'restart' ? m.game_reader_refresh({}, o) : m.album_tracks_retry({}, o)}
        </button>
      </div>
    ) : null;
  return (
    <div className="min-w-0 space-y-5" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{m.game_reader_scope({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.game_reader_return({}, o)}</p>
      <div className="rounded-lg border border-border p-3 space-y-2" data-slot="game-window-address">
        <p>
          {busy
            ? m.game_reader_requested({}, o)
            : failure
              ? m.game_reader_failed_address({}, o)
              : m.game_reader_current_address({}, o)}
        </p>
        <p className="text-sm">
          <code>{window.requested.cursor ?? m.game_reader_first_window({}, o)}</code>
        </p>
        <nav className="flex flex-wrap gap-3" aria-label={m.subject_editions({}, o)}>
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy || !window.previous}
            onClick={request(window.back)}
          >
            {m.game_reader_previous({}, o)}
          </button>
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${action}`}
            disabled={busy}
            onClick={request(window.start)}
          >
            {m.game_reader_start({}, o)}
          </button>
        </nav>
      </div>
      {busy ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {!page ? <SafeNavigation id={id} locale={locale} realm={realm} /> : null}
      {!page ? failureNotice : null}
      {page ? (
        <div key={window.revision} className="space-y-5">
          <p>
            <span lang={page.grain.lang ?? undefined}>{page.grain.text}</span> ·{' '}
            <span lang={label?.lang ?? undefined}>{label?.text}</span>
          </p>
          {pickText(page.public.subject.descriptions, locale).text ? (
            <p lang={pickText(page.public.subject.descriptions, locale).lang ?? undefined}>
              {pickText(page.public.subject.descriptions, locale).text}
            </p>
          ) : null}
          {page.public.viewerActions?.state === 'unavailable' ? (
            <p role="status">{m.game_reader_advice_unavailable({}, o)}</p>
          ) : null}
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
                    {page.workReleaseCards?.state !== 'available' ? (
                      <div role="status">
                        <p>{m.game_reader_compare_unavailable({}, o)}</p>
                        <button
                          type="button"
                          className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                          disabled={busy}
                          onClick={request(window.retry)}
                        >
                          {m.album_tracks_retry({}, o)}
                        </button>
                      </div>
                    ) : null}
                    {!page.editions.length ? <p>{m.game_reader_editions_empty({}, o)}</p> : null}
                    <ul className="space-y-4">
                      {page.editions.map((row) => {
                        const summary = row.summary;
                        const title = summary?.label;
                        const statement = row.assertion;
                        const card =
                          page.workReleaseCards?.state === 'available'
                            ? page.workReleaseCards.cards.find(
                                (candidate) =>
                                  candidate.subject === row.subject && candidate.membership.id === row.statement,
                              )
                            : undefined;
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
                            <button
                              type="button"
                              className={`${buttonVariants({ variant: 'outline' })} ${action}`}
                              onClick={(event) => {
                                if (current())
                                  setSelected({ page, row, opener: event.currentTarget, keyboard: event.detail === 0 });
                              }}
                            >
                              {m.game_reader_inspect({}, o)}
                            </button>
                            {statement ? (
                              <GameEvidence
                                statement={statement}
                                page={page}
                                related={related}
                                locale={locale}
                                link={Link}
                              />
                            ) : (
                              <p>{m.game_reader_assertion_unavailable({}, o)}</p>
                            )}
                            {selected && selected.page === page && selected.row === row ? (
                              <EditionInspection
                                selection={selected}
                                page={page}
                                locale={locale}
                                current={current}
                                link={Link}
                                close={() => setSelected(undefined)}
                              />
                            ) : null}
                            {card ? (
                              <WorkReleaseComparison card={card} page={page} locale={locale} link={Link} />
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
                        onClick={request(() => window.next(page.next!))}
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
            onClick={request(window.start)}
          >
            {m.game_reader_refresh({}, o)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

type WorkReleaseCardView = Extract<
  NonNullable<GameReaderReady['workReleaseCards']>,
  { state: 'available' }
>['cards'][number];
type WorkReleaseCardProperty = keyof WorkReleaseCardView['fields'];

function WorkReleaseComparison({
  card,
  page,
  locale,
  link,
}: {
  card: WorkReleaseCardView;
  page: GameReaderReady;
  locale: string;
  link: Parameters<typeof GameFact>[0]['link'];
}) {
  const o = { locale: locale as never };
  const related: SubjectRead['related'] = Object.fromEntries(
    Object.entries(card.related).map(([id, item]) => [
      id,
      { type: item.type, labels: item.label ? { [item.label.language]: item.label.value } : {} },
    ]),
  );
  const groups: { id: string; label: string; properties: WorkReleaseCardProperty[] }[] = [
    { id: 'platform', label: m.game_reader_compare_platform_label({}, o), properties: ['schema:gamePlatform'] },
    { id: 'language', label: m.game_reader_compare_language_label({}, o), properties: ['schema:inLanguage'] },
    { id: 'date', label: m.game_reader_compare_date_label({}, o), properties: ['schema:datePublished'] },
    {
      id: 'status',
      label: m.game_reader_compare_status_label({}, o),
      properties: ['schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus'],
    },
    { id: 'age', label: m.game_reader_compare_age_label({}, o), properties: ['wdt:P2899', 'schema:contentRating'] },
    { id: 'publisher', label: m.game_reader_compare_publisher_label({}, o), properties: ['schema:publisher'] },
    { id: 'producer', label: m.game_reader_compare_producer_label({}, o), properties: ['schema:producer', 'wdt:P162'] },
    { id: 'developer', label: m.game_reader_compare_developer_label({}, o), properties: ['wdt:P178'] },
  ];
  return (
    <section className="mt-3 space-y-2" data-slot="work-release-comparison">
      <h4 className="font-semibold">{m.game_reader_compare_title({}, o)}</h4>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
        {groups.map((group) => {
          const fields = group.properties.map((property) => card.fields[property]);
          const available = fields.filter((field) => field.state === 'available');
          const states = [
            ...new Set(fields.filter((field) => field.state !== 'available').map((field) => field.state)),
          ];
          return (
            <div key={group.id} className="min-w-0 rounded-md bg-muted/40 p-2">
              <dt className="font-medium">{group.label}</dt>
              <dd className="mt-1 space-y-2">
                {available.flatMap((field) =>
                  field.statements.map((statement) => (
                    <GameFact
                      key={statement.id}
                      statement={statement}
                      page={page}
                      related={related}
                      locale={locale}
                      date={statement.property.id === 'schema:datePublished'}
                      link={link}
                    />
                  )),
                )}
                {states.map((state) => (
                  <p key={state} className={available.length ? 'text-sm text-muted-foreground' : undefined}>
                    {state === 'unavailable'
                      ? m.game_reader_compare_field_unavailable({}, o)
                      : state === 'withheld'
                        ? m.game_reader_compare_withheld({}, o)
                        : state === 'missing'
                          ? m.game_reader_compare_missing({}, o)
                          : m.game_reader_compare_unsupported({}, o)}
                  </p>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
