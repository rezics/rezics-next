import { useState, type MouseEvent } from 'react';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { CandidateValue } from '../../pages/data';
import { PlainLink, type PageLink, type Snak, type Stmt, spoilerLevel } from '../../pages/shared';
import { SpoilerGate } from '../../pages/values';
import { ValueExplanationEntry } from '../value-explanation-entry';
import { m } from '../../../paraglide/messages.js';
import type { ScreenEpisodeEntry, ScreenEpisodeRead } from './read';
import {
  screenEpisodeContinuationHref,
  screenEpisodeEntryElementId,
  screenEpisodeRestartHref,
  screenEpisodeSelection,
  screenEpisodeSubjectHref,
  type ScreenEpisodeOrigin,
} from './navigation';
import type { useScreenEpisodeVisit } from './visit/owner';

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
  const property = release?.properties[part.property.id];
  const label = property ? pickText(property.labels, locale) : undefined;
  return (
    <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      <p lang={label?.lang ?? undefined} className="text-sm text-muted-foreground">
        {label?.text || m.subject_value_unlabelled({}, options(locale))}
      </p>
      <CandidateValue snak={part} related={entry.related ?? {}} locale={locale} link={link} />
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
  readerSpoilerLevel = 0,
  visitKey = '',
  link: Link = PlainLink,
}: {
  locale: string;
  read?: ScreenEpisodeRead;
  release?: Release;
  loading?: boolean;
  retry?: () => void;
  visit?: ReturnType<typeof useScreenEpisodeVisit>;
  origin: ScreenEpisodeOrigin;
  readerSpoilerLevel?: number;
  visitKey?: string;
  link?: PageLink;
}) {
  const o = options(locale);
  const failed = read && !read.ok ? read : undefined;
  const returnedSelection = screenEpisodeSelection(origin.searchStr);
  const [selectionState, setSelectionState] = useState<{ visitKey: string; membershipId?: string }>({ visitKey });
  if (selectionState.visitKey !== visitKey) setSelectionState({ visitKey });
  const selectedMembershipId = selectionState.membershipId;
  const selected = returnedSelection ?? selectedMembershipId;
  const selectionMissing =
    !!returnedSelection && read?.ok && !read.entries.some((entry) => entry.membershipId === returnedSelection);
  const startHref =
    visit?.startHref ??
    (new URLSearchParams(origin.searchStr).has('screenCursor') ||
    new URLSearchParams(origin.searchStr).has('screenSelection')
      ? screenEpisodeRestartHref(origin)
      : undefined);

  return (
    <section
      id="screen-episode-list"
      tabIndex={-1}
      aria-labelledby="screen-episode-list-title"
      data-screen-episode-list
      className="min-w-0 space-y-3 rounded-lg border border-border p-4"
    >
      <header className="space-y-1">
        <ContentItemHeading id="screen-episode-list-title" level={3} className="font-sans text-lg font-semibold">
          {m.screen_episode_reader_title({}, o)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.screen_episode_position_help({}, o)}</p>
      </header>
      {loading ? <p role="status">{m.candidate_loading({}, o)}</p> : null}
      {selectionMissing ? <p role="status">{m.screen_episode_reader_selection_missing({}, o)}</p> : null}
      {failed ? (
        <div className="space-y-3">
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
          {visit?.previousHref ? (
            <span
              onClickCapture={(event) =>
                visit.onNavigate('previous', visit.previousHref!, event as unknown as MouseEvent<HTMLAnchorElement>)
              }
            >
              <Link href={visit.previousHref} className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}>
                {m.screen_episode_reader_previous({}, o)}
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}
      {!loading && !read ? <p role="alert">{m.screen_reader_unavailable({}, o)}</p> : null}
      {read?.ok && read.state === 'empty' ? <p role="status">{m.screen_reader_empty({}, o)}</p> : null}
      {read?.ok && read.state === 'withheld' ? <p role="status">{m.screen_episode_reader_withheld({}, o)}</p> : null}
      {read?.ok && read.entries.some((entry) => entry.statement) ? (
        <ul aria-label={m.screen_episode_reader_title({}, o)} className="grid min-w-0 gap-2">
          {read.entries.map((entry) => {
            const statement = entry.statement;
            if (!statement) return null;
            const fallback =
              entry.type === 'schema:TVSeason'
                ? m.screen_episode_reader_season({}, o)
                : m.screen_episode_reader_episode({}, o);
            const label = entry.label || entry.typeLabel.text || fallback;
            const href = screenEpisodeSubjectHref(entry, label, locale, origin);
            const elementId = screenEpisodeEntryElementId(entry.membershipId);
            const expanded = selected === entry.membershipId;
            const content = (
              <div className="min-w-0 rounded-md bg-muted/40 p-3">
                <div
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
                  onClickCapture={(event) =>
                    visit?.onEntryNavigate(href, event as unknown as MouseEvent<HTMLAnchorElement>)
                  }
                >
                  <Link
                    href={href}
                    {...(entry.language ? { lang: entry.language } : {})}
                    className={`${actionClass} text-primary underline underline-offset-4`}
                  >
                    {label}
                  </Link>
                  <span lang={entry.typeLabel.lang ?? undefined} className="text-sm text-muted-foreground">
                    {entry.typeLabel.text || fallback}
                  </span>
                </div>
                {entry.position !== undefined ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {m.screen_episode_position({}, o)}: <span dir="auto">{entry.position}</span>
                  </p>
                ) : null}
                <button
                  type="button"
                  className={`${buttonVariants({ variant: 'ghost' })} ${actionClass} mt-2`}
                  aria-expanded={expanded}
                  {...(expanded ? { 'aria-controls': `screen-episode-evidence-${entry.membershipId}` } : {})}
                  onClick={() =>
                    setSelectionState({ visitKey, ...(expanded ? {} : { membershipId: entry.membershipId }) })
                  }
                >
                  {expanded ? m.screen_episode_reader_hide_evidence({}, o) : m.screen_episode_reader_inspect({}, o)}
                </button>
                {expanded ? <MembershipEvidence entry={entry} release={release} locale={locale} link={Link} /> : null}
              </div>
            );
            return (
              <li
                key={`${visitKey}:${entry.membershipId}:${JSON.stringify(statement)}`}
                {...(elementId ? { id: elementId } : {})}
                tabIndex={-1}
                aria-current={expanded ? 'true' : undefined}
                className="min-w-0"
              >
                {spoilerLevel(statement as unknown as Stmt) > readerSpoilerLevel ? (
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
      ) : null}
      {read?.ok ? (
        <div className="flex min-w-0 flex-wrap gap-3">
          {visit?.previousHref ? (
            <span
              onClickCapture={(event) =>
                visit.onNavigate('previous', visit.previousHref!, event as unknown as MouseEvent<HTMLAnchorElement>)
              }
            >
              <Link href={visit.previousHref} className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}>
                {m.screen_episode_reader_previous({}, o)}
              </Link>
            </span>
          ) : null}
          {read.next && visit?.canContinue !== false ? (
            <span
              onClickCapture={(event) =>
                visit?.onNavigate(
                  'continue',
                  screenEpisodeContinuationHref(origin, read.next!),
                  event as unknown as MouseEvent<HTMLAnchorElement>,
                )
              }
            >
              <Link
                href={screenEpisodeContinuationHref(origin, read.next)}
                className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}
              >
                {m.screen_episode_reader_continue({}, o)}
              </Link>
            </span>
          ) : null}
          {read.next && visit?.stopped === 'limit' ? <p role="status">{m.screen_episode_reader_limit({}, o)}</p> : null}
          {read.next && visit?.stopped === 'cycle' ? <p role="status">{m.screen_episode_reader_cycle({}, o)}</p> : null}
        </div>
      ) : null}
      {startHref ? (
        <div className="flex min-w-0 flex-wrap gap-3">
          {visit?.previousHref ? (
            <span
              onClickCapture={(event) =>
                visit.onNavigate('previous', visit.previousHref!, event as unknown as MouseEvent<HTMLAnchorElement>)
              }
            >
              <Link href={visit.previousHref} className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}>
                {m.screen_episode_reader_previous({}, o)}
              </Link>
            </span>
          ) : null}
          <span
            data-screen-episode-recovery
            tabIndex={-1}
            onClickCapture={(event) =>
              visit?.onNavigate('start', startHref, event as unknown as MouseEvent<HTMLAnchorElement>)
            }
          >
            <Link href={startHref} className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}>
              {m.screen_episode_reader_start({}, o)}
            </Link>
          </span>
        </div>
      ) : null}
    </section>
  );
}
