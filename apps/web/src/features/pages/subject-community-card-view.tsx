import { m } from '../../paraglide/messages.js';
import { RevisionProvenance } from '../../threads/revision-provenance-view';
import {
  conversationActivity,
  formatConversationReplyCount,
  threadActivity,
} from '../../threads/activity';
import { fullDateTime, timeText } from '../../threads/byline';
import { NativeDocumentImage } from '../../threads/document-media';
import type { CommunityCard, CommunityNativeCard } from './subject-community-card';
import { Byline } from '../../threads/byline';
import { SpoilerGate } from './values';

export function CommunityNativeByline({
  card,
  createdAt,
  now,
  locale,
}: {
  card: CommunityNativeCard;
  createdAt: string;
  now: string;
  locale: string;
}) {
  const author = card.author;
  const name = author?.displayName || author?.handle || m.thread_author_unknown({}, { locale: locale as never });
  return (
    <div data-slot="community-native-author" className="min-w-0 text-sm [overflow-wrap:anywhere]">
      {author?.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(author.handle) ? (
        <a
          className="inline-flex min-h-11 min-w-11 items-center text-primary hover:underline"
          href={`/${locale}/@${encodeURIComponent(author.handle)}`}
        >
          <bdi>{name}</bdi>
        </a>
      ) : (
        <bdi>{name}</bdi>
      )}
      <Byline author={undefined} createdAt={createdAt} now={now} showAuthor={false} size="sm" />
    </div>
  );
}

/** The native public activity coverage is independent of presentation and recorded rating provenance. */
export function CommunityNativePresentation({
  card,
  summary,
  locale,
  now,
  retryHref,
}: {
  card: CommunityNativeCard;
  summary: string;
  locale: string;
  now: string;
  retryHref?: string;
}) {
  const options = { locale: locale as never };
  const content = card.presentation ? (
    <div lang={card.presentation.language ?? undefined} className="min-w-0 space-y-2">
      {summary ? (
        <p data-content-item-slot="preview" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {summary}
        </p>
      ) : null}
      {card.media.map(({ image, alt }) => (
        <NativeDocumentImage key={image.id} image={image} alt={alt} locale={locale} />
      ))}
    </div>
  ) : null;
  const activity = conversationActivity(card.comments ?? undefined);
  return (
    <div className="min-w-0 space-y-2 [&_button]:min-h-11 [&_button]:min-w-11 [&_a]:min-h-11 [&_a]:min-w-11">
      {card.presentation?.spoiler ? (
        <SpoilerGate label={m.subject_spoiler_show({}, options)} hideLabel={m.subject_spoiler_hide({}, options)}>
          {content}
        </SpoilerGate>
      ) : (
        content
      )}
      {activity.state === 'current' ? (
        <p data-slot="community-activity" className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span
            aria-label={
              activity.count.kind === 'lower-bound'
                ? m.board_thread_replies_lower_bound(
                    { count: formatConversationReplyCount(activity.count, locale).replace(/\+$/, '') },
                    options,
                  )
                : undefined
            }
          >
            {m.board_thread_replies({ count: formatConversationReplyCount(activity.count, locale) }, options)}
          </span>
          {activity.lastActivityAt ? (
            <time dateTime={activity.lastActivityAt} title={fullDateTime(activity.lastActivityAt, locale)}>
              {m.board_thread_last_activity({ time: timeText(activity.lastActivityAt, now, locale) }, options)}
            </time>
          ) : null}
        </p>
      ) : (
        <div data-slot="community-activity" role="status" className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span>{m.board_thread_activity_unavailable({}, options)}</span>
          {retryHref ? (
            <a href={retryHref} className="text-primary underline underline-offset-4">
              {m.subject_section_retry({}, options)}
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function CommunityRecordedCitation({
  citation,
  locale,
  licence,
}: {
  licence: string;
  citation: CommunityCard['citation'];
  locale: string;
}) {
  const options = { locale: locale as never };
  if (citation.state !== 'available')
    return (
      <p role={citation.state === 'withheld' ? 'status' : undefined} className="text-sm text-muted-foreground">
        {citation.state === 'absent'
          ? m.thread_provenance_unscored({}, options)
          : m.subject_community_citation_unavailable({}, options)}
      </p>
    );
  const { question, recorded, originalTarget } = citation;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return (
    <aside
      className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]"
      aria-label={m.thread_provenance_rating({}, options)}
    >
      <p>{question.label}</p>
      <p>
        {m.subject_community_recorded_scale(
          {
            min: number(question.scale.min),
            max: number(question.scale.max),
            step: number(question.scale.displayStep),
          },
          options,
        )}
      </p>
      {question.lifecycle.state === 'retired' ? <p>{m.subject_community_retired_question({}, options)}</p> : null}
      <RevisionProvenance
        revision={{ licence, subjectIds: [originalTarget.id], voteCitation: recorded }}
        subjects={[
          {
            id: originalTarget.id,
            types: [],
            label: originalTarget.label ?? originalTarget.id,
            labels: { [locale]: originalTarget.label ?? originalTarget.id },
            cover: null,
          },
        ]}
        review
        showLicence={false}
      />
      <p>{m.rating_question_revision({ revision: number(question.revision) }, options)}</p>
      <div data-slot="community-original-target">
        <p>
          {m.subject_community_original_target({}, options)}: {originalTarget.id}
        </p>
        {originalTarget.mergedInto ? (
          <p>{m.subject_community_merged_target({ id: originalTarget.mergedInto }, options)}</p>
        ) : null}
      </div>
    </aside>
  );
}

/** Native media and activity owners receive only the same exact, already disclosed card observation. */
export function CommunityCardPresentation({ card, locale, now }: { card: CommunityCard; locale: string; now: string }) {
  const activity = card.activity ? threadActivity(card.activity) : null;
  const options = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-2 [&_button]:min-h-11 [&_button]:min-w-11 [&_a]:min-h-11 [&_a]:min-w-11">
      {activity && activity.replyCount !== null && activity.lastActivityAt !== null ? (
        <p data-slot="community-activity" className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span>
            {m.board_thread_replies({ count: new Intl.NumberFormat(locale).format(activity.replyCount) }, options)}
          </span>
          <time dateTime={activity.lastActivityAt} title={fullDateTime(activity.lastActivityAt, locale)}>
            {m.board_thread_last_activity({ time: timeText(activity.lastActivityAt, now, locale) }, options)}
          </time>
        </p>
      ) : null}
      {card.media.map(({ image, alt }) => (
        <NativeDocumentImage key={image.id} image={image} alt={alt} locale={locale} />
      ))}
    </div>
  );
}
