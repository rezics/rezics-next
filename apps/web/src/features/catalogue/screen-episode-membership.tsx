import { useState } from 'react';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { EditorFailure } from './statement-editor-view';
import { RelationEditor } from './relation-editor';
import type { RelationTransport } from '../../subject/relation-candidates';
import {
  episodeJourneyFromCreate,
  episodeMembershipAdmission,
  episodeMembershipProperty,
  episodeType,
  locateCreatedChild,
  markEpisodeLinked,
  membershipCreateStatement,
  screenSeriesId,
  seriesEpisodeEntry,
  seriesPartsHref,
  seriesUuid,
  type EpisodeJourney,
  type MembershipDraft,
} from './screen-episode-membership.ts';
import type { ScreenRead } from './screen-profile';

export {
  episodeJourneyFromCreate,
  episodeMembershipAdmission,
  episodeMembershipProperty,
  episodeType,
  locateCreatedChild,
  markEpisodeLinked,
  membershipCreateStatement,
  screenSeriesId,
  seriesEpisodeEntry,
  seriesPartsHref,
  seriesUuid,
};
export type { EpisodeJourney, MembershipDraft };

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';

type Ready = Extract<ScreenRead, { ok: true }>;

export function ScreenEpisodeMembership({
  read,
  locale,
  disabled,
  draft,
  change,
}: {
  read: Ready;
  locale: string;
  disabled: boolean;
  draft: MembershipDraft | undefined;
  change: (draft: MembershipDraft | undefined) => void;
}) {
  const o = { locale: locale as never };
  const admission = episodeMembershipAdmission(read.release, read.series?.subject.type);
  const [position, setPosition] = useState(draft?.position ?? '');
  const suggestion = read.series;
  const suggestionId = read.seriesId;
  const title = pickText(suggestion?.subject.labels ?? {}, locale);
  const canConfirm = !disabled && admission.admitted && admission.seriesAdmitted && !!suggestion;
  return (
    <section className="min-w-0 space-y-4">
      <header className="space-y-2">
        <ContentItemHeading level={2} className="font-sans text-lg font-semibold">
          {m.screen_episode_membership_title({}, o)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.screen_episode_membership_intro({}, o)}</p>
      </header>
      {suggestionId && (
        <ContentItemFrame as="div" className="min-w-0 space-y-2 rounded-xl bg-muted/30 p-4">
          <h3 className="font-semibold">{m.screen_episode_series_suggestion({}, o)}</h3>
          {suggestion ? (
            <>
              <p>
                <a
                  className="underline underline-offset-4"
                  href={subjectHref({ id: suggestion.subject.id, label: title.text }, locale).href}
                  lang={title.lang ?? undefined}
                >
                  {title.text || m.subject_value_unlabelled({}, o)}
                </a>
              </p>
              <p>
                <code className="break-all text-xs">{suggestion.subject.id}</code> · {suggestion.subject.type}
              </p>
              {read.seriesIssue && <EditorFailure locale={locale} reason={read.seriesIssue} />}
            </>
          ) : (
            <>
              <p className="break-all text-sm">
                <code>{suggestionId}</code>
              </p>
              <EditorFailure locale={locale} reason={read.seriesIssue ?? 'unavailable'} />
            </>
          )}
          <p className="text-sm">{m.screen_episode_series_note({}, o)}</p>
        </ContentItemFrame>
      )}
      {!admission.admitted && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.screen_episode_membership_withdrawn({}, o)}
        </p>
      )}
      {admission.admitted && suggestionId && !admission.seriesAdmitted && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.screen_episode_membership_unavailable({}, o)}
        </p>
      )}
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        {admission.positionAdmitted ? (
          <Field>
            <FieldLabel htmlFor="screen-episode-position">{m.screen_episode_position({}, o)}</FieldLabel>
            <Input
              id="screen-episode-position"
              value={draft?.position ?? position}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value;
                setPosition(value);
                if (draft) change({ ...draft, position: value });
              }}
            />
            <p className="text-sm text-muted-foreground">{m.screen_episode_position_help({}, o)}</p>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">{m.screen_episode_position_unavailable({}, o)}</p>
        )}
        {draft ? (
          <ContentItemFrame as="div" className="min-w-0 space-y-2 rounded-xl bg-card p-4">
            <p className="text-sm text-muted-foreground">{m.screen_episode_membership_confirmed({}, o)}</p>
            <p className="text-sm">
              <code className="break-all">{draft.target}</code>
            </p>
            <Button type="button" variant="outline" className={actionClassName} onClick={() => change(undefined)}>
              {m.relation_remove({}, o)}
            </Button>
          </ContentItemFrame>
        ) : (
          <Button
            type="button"
            variant="outline"
            className={actionClassName}
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm || !suggestion) return;
              change({ target: suggestion.subject.id, position: position.trim() });
            }}
          >
            {m.screen_episode_membership_confirm({}, o)}
          </Button>
        )}
      </fieldset>
      {suggestion && (
        <a
          className={`${actionClassName} inline-flex items-center underline`}
          href={seriesPartsHref({ id: suggestion.subject.id, label: title.text }, locale)}
        >
          {m.screen_episode_cancel({}, o)}
        </a>
      )}
    </section>
  );
}

export function ScreenEpisodeResult({
  journey,
  series,
  locale,
  membership,
  search,
  relations,
  onLinked,
  onRetryRead,
}: {
  journey: Exclude<EpisodeJourney, { stage: 'edit' }>;
  series: { id: string; label: string };
  locale: string;
  membership?: MembershipDraft | undefined;
  search: EntityPickerSearch;
  relations?: ((id: string) => RelationTransport) | undefined;
  onLinked: (next: Exclude<EpisodeJourney, { stage: 'edit' }>) => void;
  onRetryRead: () => void;
}) {
  const o = { locale: locale as never };
  const returnHref = seriesPartsHref(series, locale, journey.id);
  const showLink = journey.stage === 'unlinked';
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6" role="status">
      <h2 className="font-sans text-lg font-semibold">{m.screen_episode_created({}, o)}</h2>
      {journey.stage === 'unread' && <p>{m.screen_episode_unread({}, o)}</p>}
      {journey.stage === 'unlinked' && <p>{m.screen_episode_unlinked({}, o)}</p>}
      {journey.stage === 'linked' && <p>{m.screen_episode_linked({}, o)}</p>}
      <p>
        <code className="break-all text-sm">{journey.id}</code>
      </p>
      {journey.stage === 'unread' ? (
        <Button type="button" className={actionClassName} variant="outline" onClick={onRetryRead}>
          {m.catalogue_create_retry({}, o)}
        </Button>
      ) : (
        'reader' in journey &&
        journey.reader.state === 'ready' && (
          <a className={`${actionClassName} inline-flex items-center underline`} href={journey.reader.href}>
            {m.screen_episode_open_created({}, o)}
          </a>
        )
      )}
      {showLink && relations && (
        <div className="space-y-3">
          <h3 className="font-semibold">{m.screen_episode_link_outstanding({}, o)}</h3>
          <RelationEditor
            id={journey.id}
            locale={locale}
            search={search}
            transport={relations(journey.id)}
            initialProperty={episodeMembershipProperty}
            propertyIds={[episodeMembershipProperty]}
            composition={{
              statement: {
                property: { id: episodeMembershipProperty, data_type: 'wikibase-item' },
                value: { type: 'value', content: membership?.target ?? series.id },
                qualifiers: [],
                references: [],
              },
              slot: { property: episodeMembershipProperty, target: membership?.target ?? series.id },
              positionEditable: false,
            }}
            onSelected={() => onLinked(markEpisodeLinked(journey))}
          />
        </div>
      )}
      {journey.stage !== 'unread' && (
        <a className={`${actionClassName} inline-flex items-center font-medium underline`} href={returnHref}>
          {m.screen_episode_return_parts({}, o)}
        </a>
      )}
    </section>
  );
}
