import { useState, type MouseEvent } from 'react';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { PlainLink, type PageLink, type Snak, type Stmt, spoilerLevel } from '../../pages/shared';
import { ValueExplanationEntry } from '../value-explanation-entry';
import { m } from '../../../paraglide/messages.js';
import { useScreenReadingApplication } from '../screen-reading-application';
import type { ScreenEpisodeEntry, ScreenEpisodeRead } from './read';
import {
  screenEpisodeContinuationHref,
  screenEpisodeEntryElementId,
  screenEpisodeRestartHref,
  screenEpisodeSelection,
  screenEpisodeSubjectHref,
  type ScreenEpisodeOrigin,
} from './navigation';
import type { ScreenEpisodeVisit } from './visit/owner';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function options(locale: string) {
  return { locale: locale as never };
}

function EvidencePart({
  entry,
  part,
  release,
  locale,
  link,
}: {
  entry: ScreenEpisodeEntry;
  part: Snak;
  release?: Release | undefined;
  locale: string;
  link: PageLink;
}) {
  const { PageValue } = useScreenReadingApplication();
  const property = release?.properties[part.property.id];
  const label = property ? pickText(property.labels, locale) : undefined;
  return (
    <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      <p lang={label?.lang ?? undefined} className="text-sm text-muted-foreground">
        {label?.text || m.subject_value_unlabelled({}, options(locale))}
      </p>
      <PageValue snak={part} related={entry.related ?? {}} locale={locale} link={link} />
    </div>
  );
}

function MembershipEvidence({
  entry,
  release,
  locale,
  link,
}: {
  entry: ScreenEpisodeEntry;
  release?: Release | undefined;
  locale: string;
  link: PageLink;
}) {
  const statement = entry.statement;
  if (!statement) return null;
  const allowed = new Set(release?.properties[statement.property.id]?.qualifiers ?? []);
  const qualifiers = statement.qualifiers.filter((part) => allowed.has(part.property.id));
  const o = options(locale);
  const label = entry.label || entry.typeLabel.text || m.screen_episode_reader_episode({}, o);
  return (
    <div
      className="mt-3 space-y-3 rounded-md border border-border p-3"
      id={`screen-episode-evidence-${entry.membershipId}`}
    >
      <h4 className="font-medium">{m.screen_episode_reader_evidence({}, o)}</h4>
      {qualifiers.map((part, index) => (
        <EvidencePart
          key={`qualifier-${part.property.id}-${index}`}
          entry={entry}
          part={part}
          release={release}
          locale={locale}
          link={link}
        />
      ))}
      {statement.references.map((reference, referenceIndex) => (
        <section key={`reference-${referenceIndex}`} className="space-y-2 border-t border-border pt-3">
          <h5 className="text-sm font-medium">{m.subject_source({}, o)}</h5>
          {reference.parts.map((part, partIndex) => (
            <EvidencePart
              key={`reference-${referenceIndex}-${part.property.id}-${partIndex}`}
              entry={entry}
              part={part}
              release={release}
              locale={locale}
              link={link}
            />
          ))}
        </section>
      ))}
      <ValueExplanationEntry
        id={entry.holderId}
        title={label}
        statement={entry.membershipId}
        property={statement.property.id}
        context={entry.context}
        locale={locale}
      />
    </div>
  );
}

export function ScreenEpisodeList({
  locale,
  read,
  release,
  loading = false,
  retry,
  visit,
  origin,
  parentType,
  readerSpoilerLevel = 0,
  visitKey = '',
  link: Link = PlainLink,
}: {
  locale: string;
  read?: ScreenEpisodeRead;
  release?: Release;
  loading?: boolean;
  retry?: () => void;
  visit?: ScreenEpisodeVisit;
  origin: ScreenEpisodeOrigin;
  parentType?: string;
  readerSpoilerLevel?: number;
  visitKey?: string;
  link?: PageLink;
}) {
  const { SpoilerGate, subjectHref, visitReturn } = useScreenReadingApplication();
  const o = options(locale);
  const title =
    parentType === 'schema:TVSeason'
      ? m.screen_episode_reader_episodes_title({}, o)
      : m.screen_episode_reader_title({}, o);
  const failed = read && !read.ok ? read : undefined;
  const returnedSelection = screenEpisodeSelection(origin.searchStr);
  const [selectionState, setSelectionState] = useState<{ visitKey: string; membershipId?: string }>({ visitKey });
  if (selectionState.visitKey !== visitKey) setSelectionState({ visitKey });
  const selected = returnedSelection ?? selectionState.membershipId;
  const selectionMissing =
    !!returnedSelection && read?.ok && !read.entries.some((entry) => entry.membershipId === returnedSelection);
  const startHref =
    visit?.startHref ??
    (new URLSearchParams(origin.searchStr).has('screenCursor') ||
    new URLSearchParams(origin.searchStr).has('screenSelection')
      ? screenEpisodeRestartHref(origin)
      : undefined);
  const hrefs = { subjectHref, visitReturn };
  const nextHref =
    read?.ok && read.next && visit?.canContinue !== false
      ? screenEpisodeContinuationHref(origin, read.next)
      : undefined;

  function windowLink(href: string, kind: 'continue' | 'previous' | 'start', label: string) {
    return (
      <span
        onClickCapture={(event) => visit?.onNavigate(kind, href, event as unknown as MouseEvent<HTMLAnchorElement>)}
      >
        <Link href={href} className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}>
          {label}
        </Link>
      </span>
    );
  }
  return (
    <section
      id="screen-episode-list"
      tabIndex={-1}
      aria-labelledby="screen-episode-list-title"
      data-screen-episode-list
      data-screen-parent-type={parentType}
      className="min-w-0 space-y-4 border-t border-border pt-5"
    >
      <header className="min-w-0 space-y-1">
        <ContentItemHeading id="screen-episode-list-title" level={3} className="font-sans text-lg font-semibold">
          {title}
        </ContentItemHeading>
        <p className="max-w-prose text-sm text-muted-foreground">{m.screen_episode_position_help({}, o)}</p>
      </header>
      {loading ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {selectionMissing ? <p role="status">{m.screen_episode_reader_selection_missing({}, o)}</p> : null}
      {failed ? (
        <div className="min-w-0 space-y-3">
          <p role="alert">
            {failed.reason === 'stale'
              ? m.screen_reader_stale({}, o)
              : failed.reason === 'unsupported'
                ? m.screen_episode_reader_unsupported({}, o)
                : m.screen_reader_unavailable({}, o)}
          </p>
          {failed.reason !== 'stale' && retry ? (
            <button
              type="button"
              className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}
              data-screen-episode-recovery
              onClick={(event) => {
                visit?.onRetry(event);
                retry();
              }}
            >
              {m.correction_retry({}, o)}
            </button>
          ) : null}
        </div>
      ) : null}
      {!loading && !read ? <p role="alert">{m.screen_reader_unavailable({}, o)}</p> : null}
      {read?.ok && read.state === 'empty' ? <p role="status">{m.screen_reader_empty({}, o)}</p> : null}
      {read?.ok && read.state === 'withheld' ? <p role="status">{m.screen_episode_reader_withheld({}, o)}</p> : null}
      {read?.ok && read.entries.some((entry) => entry.statement) ? (
        <ul aria-label={title} className="grid min-w-0 divide-y divide-border rounded-lg border border-border">
          {read.entries.map((entry) => {
            const statement = entry.statement;
            if (!statement) return null;
            const fallback =
              entry.type === 'schema:TVSeason'
                ? m.screen_episode_reader_season({}, o)
                : m.screen_episode_reader_episode({}, o);
            const label = entry.label || entry.typeLabel.text || fallback;
            const href = screenEpisodeSubjectHref(entry, label, locale, origin, hrefs);
            const elementId = screenEpisodeEntryElementId(entry.membershipId);
            const expanded = selected === entry.membershipId;
            const content = (
              <div className="min-w-0 p-3 sm:p-4">
                <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 sm:flex-nowrap">
                  {entry.position !== undefined ? (
                    <p className="min-w-0 max-w-full shrink-0 rounded-md bg-muted px-2 py-1 text-sm text-muted-foreground sm:max-w-24">
                      <span className="sr-only">{m.screen_episode_position({}, o)}: </span>
                      <span dir="auto" className="[overflow-wrap:anywhere]">
                        {entry.position}
                      </span>
                    </p>
                  ) : null}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div
                      onClickCapture={(event) =>
                        visit?.onEntryNavigate(href, event as unknown as MouseEvent<HTMLAnchorElement>)
                      }
                    >
                      <Link
                        href={href}
                        {...(entry.language ? { lang: entry.language } : {})}
                        className={`${actionClass} inline-flex items-center font-medium text-primary underline-offset-4 hover:underline`}
                      >
                        {label}
                      </Link>
                    </div>
                    <p
                      lang={entry.typeLabel.lang ?? undefined}
                      className="text-sm text-muted-foreground [overflow-wrap:anywhere]"
                    >
                      {entry.typeLabel.text || fallback}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${buttonVariants({ variant: 'ghost' })} ${actionClass} shrink-0 text-sm`}
                    aria-expanded={expanded}
                    {...(expanded ? { 'aria-controls': `screen-episode-evidence-${entry.membershipId}` } : {})}
                    onClick={() =>
                      setSelectionState({ visitKey, ...(expanded ? {} : { membershipId: entry.membershipId }) })
                    }
                  >
                    {expanded ? m.screen_episode_reader_hide_evidence({}, o) : m.screen_episode_reader_inspect({}, o)}
                  </button>
                </div>
                {expanded ? <MembershipEvidence entry={entry} release={release} locale={locale} link={Link} /> : null}
              </div>
            );
            return (
              <li
                key={`${visitKey}:${entry.membershipId}:${JSON.stringify(statement)}`}
                {...(elementId ? { id: elementId } : {})}
                tabIndex={-1}
                aria-current={expanded ? 'true' : undefined}
                data-screen-member-type={entry.type}
                className="min-w-0 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {spoilerLevel(statement as unknown as Stmt) > readerSpoilerLevel ? (
                  <SpoilerGate
                    label={m.subject_spoiler_show({}, o)}
                    hideLabel={m.subject_spoiler_hide({}, o)}
                    unmountOnHide
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
      ) : null}
      {visit?.previousHref || nextHref || startHref ? (
        <nav aria-label={title} className="flex min-w-0 flex-wrap items-center gap-3">
          {visit?.previousHref
            ? windowLink(visit.previousHref, 'previous', m.screen_episode_reader_previous({}, o))
            : null}
          {nextHref ? windowLink(nextHref, 'continue', m.screen_episode_reader_continue({}, o)) : null}
          {startHref ? (
            <span data-screen-episode-recovery tabIndex={-1}>
              {windowLink(startHref, 'start', m.screen_episode_reader_start({}, o))}
            </span>
          ) : null}
        </nav>
      ) : null}
      {read?.ok && read.next && visit?.stopped === 'limit' ? (
        <p role="status">{m.screen_episode_reader_limit({}, o)}</p>
      ) : null}
      {read?.ok && read.next && visit?.stopped === 'cycle' ? (
        <p role="status">{m.screen_episode_reader_cycle({}, o)}</p>
      ) : null}
    </section>
  );
}
