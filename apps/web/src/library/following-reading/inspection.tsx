import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { SubjectCover } from '../subject-row';
import type { FollowingSelection } from './current-selection';
import { currentSpaceDestination, suppliedRealmMembershipHref, type FollowingDestination } from './destinations';
import { FollowingReference } from './reference';
import { readFollowingSpace } from './space-actions';
import type { SpaceReading, SpaceReadInput, SpaceRead } from './space-reader';
import { followingDestinationClick, type FollowingReturnFrontier } from './return-context';

export type FollowingSpaceReader = (input: SpaceReadInput) => Promise<SpaceRead>;
const nativeRead: FollowingSpaceReader = (data) => readFollowingSpace({ data });
type Reading = SpaceReading | { state: 'preparing' };

/** One request identity, retired synchronously on close, replacement and retry. No private cache. */
export function useSelectedSpace(
  selection: FollowingSelection,
  subject: string | null,
  locale: string,
  read: FollowingSpaceReader = nativeRead,
) {
  const [attempt, setAttempt] = useState(0);
  const [, render] = useState(0);
  const request = useRef<{ key: string; active: boolean; mounted: boolean; started: boolean; result: Reading } | null>(
    null,
  );
  const key = JSON.stringify([selection.id, subject, locale, attempt]);
  if (request.current?.key !== key) {
    if (request.current) request.current.active = false;
    request.current = { key, active: true, mounted: false, started: false, result: { state: 'preparing' } };
  }
  const observation = request.current;
  const current = () =>
    observation.active && observation.mounted && request.current === observation && selection.current();
  const { follow } = selection.row;
  useEffect(() => {
    observation.mounted = true;
    if (follow.targetType !== 'space' || !follow.target || !subject || !current()) return;
    if (observation.started)
      return () => {
        observation.mounted = false;
      };
    observation.started = true;
    const input = { subject, locale, spaceId: follow.targetId };
    void read(input).then(
      (response) => {
        if (!current()) return;
        observation.result =
          response.subject === subject && response.locale === locale && response.spaceId === follow.targetId
            ? response.result
            : { state: 'unavailable' };
        render((n) => n + 1);
      },
      () => {
        if (!current()) return;
        observation.result = { state: 'unavailable' };
        render((n) => n + 1);
      },
    );
    return () => {
      observation.mounted = false;
    };
  }, [observation, read]);
  return {
    result: selection.current() ? observation.result : { state: 'retired' as const },
    retry: () => {
      if (current()) {
        observation.active = false;
        setAttempt((n) => n + 1);
      }
    },
    current,
  };
}

export function FollowingInspection({
  selection,
  subject,
  locale,
  canReadCollection,
  close,
  readSpace,
  returnFrontier = null,
}: {
  selection: FollowingSelection;
  subject: string | null;
  locale: string;
  canReadCollection: boolean;
  close: () => void;
  readSpace?: FollowingSpaceReader | undefined;
  returnFrontier?: FollowingReturnFrontier | null;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { follow, title, targetKind, kind, reason, destination: supplied } = selection.row;
  const space = useSelectedSpace(selection, subject, locale, readSpace);
  useLayoutEffect(() => {
    if (selection.current()) heading.current?.focus();
  }, [selection]);
  if (!selection.current()) return null;
  const isSpace = follow.targetType === 'space' && !!follow.target;
  const ready = isSpace && space.result.state === 'ready' ? space.result.space : null;
  const destination: FollowingDestination | null = isSpace
    ? ready
      ? currentSpaceDestination(follow, ready, locale)
      : null
    : supplied?.kind === 'collection' && !canReadCollection
      ? null
      : supplied;
  const actionHref = ready ? suppliedRealmMembershipHref(follow, ready, locale) : null;
  const stateText = !follow.target
    ? m.following_reading_identity_unavailable()
    : !isSpace
      ? null
      : space.result.state === 'preparing'
        ? m.following_reading_preparing()
        : space.result.state === 'denied'
          ? m.following_reading_denied()
          : space.result.state === 'retired'
            ? m.following_reading_retired()
            : space.result.state === 'unavailable'
              ? m.following_reading_unavailable()
              : null;
  const collectionWithdrawn = supplied?.kind === 'collection' && !canReadCollection;
  return (
    <section
      id="following-inspection"
      role="dialog"
      aria-labelledby="following-inspection-title"
      className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">{m.following_reading_inspection()}</p>
          <Button className="min-h-11" variant="ghost" onClick={close}>
            {m.following_reading_close()}
          </Button>
        </div>
        <div className="flex min-w-0 items-start gap-4">
          {follow.target?.cover ? <SubjectCover subject={follow.target} ratio="2:3" size="md" /> : null}
          <div className="min-w-0 space-y-2">
            <h2
              ref={heading}
              tabIndex={-1}
              id="following-inspection-title"
              lang={title.lang}
              className="text-xl leading-snug font-semibold wrap-anywhere outline-offset-4 sm:text-2xl"
            >
              {title.text}
            </h2>
            <p className="flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="font-medium">{targetKind}</span>
              {kind !== targetKind ? <span>{kind}</span> : null}
            </p>
          </div>
        </div>
      </header>
      {ready ? (
        <div className="min-w-0 space-y-2" data-following-current-identity="">
          <h3 className="text-sm font-medium text-muted-foreground">{m.following_reading_current_identity()}</h3>
          {ready.title !== title.text ? (
            <p className="text-lg leading-snug font-semibold wrap-anywhere">{ready.title}</p>
          ) : null}
          {ready.summary ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed wrap-anywhere">{ready.summary}</p>
          ) : null}
        </div>
      ) : null}
      {stateText ? (
        <p role="status" className="text-sm leading-relaxed">
          {stateText}
        </p>
      ) : null}
      {collectionWithdrawn ? (
        <p role="status" className="text-sm leading-relaxed">
          {m.following_reading_collection_withdrawn()}
        </p>
      ) : null}
      {isSpace &&
      (space.result.state === 'unavailable' || space.result.state === 'denied' || space.result.state === 'retired') ? (
        <Button
          className="min-h-11"
          variant="outline"
          onClick={() => {
            if (!space.current()) return;
            heading.current?.focus();
            space.retry();
          }}
        >
          {m.library_follow_retry()}
        </Button>
      ) : null}
      <div className="space-y-3">
        {destination ? (
          <a
            className={buttonVariants({
              variant: 'default',
              className: 'min-h-11 max-w-full whitespace-normal break-words',
            })}
            href={destination.href}
            onClick={(event) => {
              followingDestinationClick(
                event,
                () => selection.current() && (!isSpace || space.current()),
                returnFrontier,
              );
            }}
          >
            {destination.kind === 'realm'
              ? m.following_reading_open_realm()
              : m.following_reading_open({ title: ready?.title ?? title.text })}
          </a>
        ) : (!isSpace || ready) && !collectionWithdrawn ? (
          <p role="status" className="text-sm leading-relaxed">
            {m.following_reading_no_destination()}
          </p>
        ) : null}
        {destination ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{m.following_reading_destination_admission()}</p>
        ) : null}
        {actionHref && actionHref !== destination?.href ? (
          <a
            className={buttonVariants({
              variant: 'outline',
              className: 'min-h-11 max-w-full whitespace-normal break-words',
            })}
            href={actionHref}
            onClick={(event) => {
              followingDestinationClick(event, () => selection.current() && space.current(), returnFrontier);
            }}
          >
            {m.realm_membership_label()}
          </a>
        ) : null}
      </div>
      <details className="group min-w-0 border-t border-border pt-2">
        <summary className="min-h-11 cursor-pointer content-center py-2 text-sm font-medium text-muted-foreground outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
          {m.following_reading_details()}
        </summary>
        <div className="min-w-0 space-y-5 pt-3">
          <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            <p>{reason}</p>
            <p>{m.following_reading_meaning()}</p>
            <p>{m.following_reading_remove_meaning()}</p>
            {actionHref ? null : <p>{m.following_reading_actions_unavailable()}</p>}
          </div>
          <dl className="min-w-0 space-y-4">
            <FollowingReference
              label={
                follow.targetType === 'space'
                  ? m.following_reading_space_id()
                  : follow.targetType === 'collection'
                    ? m.following_reading_collection_id()
                    : m.following_reading_subject_id()
              }
              value={follow.targetId}
              current={selection.current}
            />
            {ready?.address ? (
              <FollowingReference
                label={m.following_reading_space_address()}
                value={ready.address}
                current={space.current}
              />
            ) : null}
            {ready?.realmId ? (
              <FollowingReference
                label={m.following_reading_realm_id()}
                value={ready.realmId}
                current={space.current}
              />
            ) : null}
          </dl>
        </div>
      </details>
      <Button className="min-h-11 max-w-full whitespace-normal" variant="outline" onClick={close}>
        {m.following_reading_return_controls()}
      </Button>
    </section>
  );
}
