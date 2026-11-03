import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { SubjectCover } from '../subject-row';
import type { FollowingSelection } from './current-selection';
import { spaceDestination, type FollowingDestination } from './destinations';
import { FollowingReference } from './reference';
import { readFollowingSpace } from './space-actions';
import type { SpaceReading, SpaceReadInput, SpaceRead } from './space-reader';

export type FollowingSpaceReader = (input: SpaceReadInput) => Promise<SpaceRead>;
const nativeRead: FollowingSpaceReader = data => readFollowingSpace({ data });
type Reading = SpaceReading | { state: 'preparing' };

/** One request identity, retired synchronously on close, replacement and retry. No private cache. */
export function useSelectedSpace(selection: FollowingSelection, subject: string | null, locale: string, read: FollowingSpaceReader = nativeRead) {
  const [attempt, setAttempt] = useState(0);
  const [, render] = useState(0);
  const request = useRef<{ key: string; active: boolean; mounted: boolean; started: boolean; result: Reading } | null>(null);
  const key = JSON.stringify([selection.id, subject, locale, attempt]);
  if (request.current?.key !== key) {
    if (request.current) request.current.active = false;
    request.current = { key, active: true, mounted: false, started: false, result: { state: 'preparing' } };
  }
  const observation = request.current;
  const current = () => observation.active && observation.mounted && request.current === observation && selection.current();
  const { follow } = selection.row;
  useEffect(() => {
    observation.mounted = true;
    if (follow.targetType !== 'space' || !follow.target || !subject || !current()) return;
    if (observation.started) return () => { observation.mounted = false; };
    observation.started = true;
    const input = { subject, locale, spaceId: follow.targetId };
    void read(input).then(response => {
      if (!current()) return;
      observation.result = response.subject === subject && response.locale === locale && response.spaceId === follow.targetId
        ? response.result : { state: 'unavailable' };
      render(n => n + 1);
    }, () => {
      if (!current()) return;
      observation.result = { state: 'unavailable' };
      render(n => n + 1);
    });
    return () => { observation.mounted = false; };
  }, [observation, read]);
  return {
    result: selection.current() ? observation.result : { state: 'retired' as const },
    retry: () => { if (current()) { observation.active = false; setAttempt(n => n + 1); } },
    current,
  };
}

export function FollowingInspection({ selection, subject, locale, canReadCollection, close, readSpace }: {
  selection: FollowingSelection;
  subject: string | null;
  locale: string;
  canReadCollection: boolean;
  close: () => void;
  readSpace?: FollowingSpaceReader | undefined;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { follow, title, kind, reason, destination: supplied } = selection.row;
  const space = useSelectedSpace(selection, subject, locale, readSpace);
  useLayoutEffect(() => { if (selection.current()) heading.current?.focus(); }, [selection]);
  if (!selection.current()) return null;
  const isSpace = follow.targetType === 'space' && !!follow.target;
  const ready = isSpace && space.result.state === 'ready' ? space.result.space : null;
  const destination: FollowingDestination | null = isSpace
    ? ready ? spaceDestination(ready, locale) : null
    : supplied?.kind === 'collection' && !canReadCollection ? null : supplied;
  const stateText = !follow.target ? m.following_reading_identity_unavailable()
    : !isSpace ? null
    : space.result.state === 'preparing' ? m.following_reading_preparing()
    : space.result.state === 'denied' ? m.following_reading_denied()
    : space.result.state === 'retired' ? m.following_reading_retired()
    : space.result.state === 'unavailable' ? m.following_reading_unavailable() : null;
  return <section role="dialog" aria-labelledby="following-inspection-title" className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-muted-foreground">{m.following_reading_inspection()}</p>
        <h2 ref={heading} tabIndex={-1} id="following-inspection-title" lang={title.lang} className="break-words text-xl font-semibold outline-offset-4">{title.text}</h2>
        <p>{kind}</p>
      </div>
      <Button className="min-h-11" variant="outline" onClick={close}>{m.following_reading_close()}</Button>
    </header>
    {follow.target?.cover ? <SubjectCover subject={follow.target} ratio="2:3" size="md" /> : null}
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>{reason}</p><p>{m.following_reading_meaning()}</p>
      <p>{m.following_reading_remove_meaning()}</p>
    </div>
    {stateText ? <p role="status">{stateText}</p> : null}
    {ready ? <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{m.following_reading_current_identity()}</h3>
      <p className="break-words text-lg font-semibold">{ready.title}</p>
      {ready.summary ? <p className="whitespace-pre-wrap break-words">{ready.summary}</p> : null}
    </div> : null}
    {isSpace && (space.result.state === 'unavailable' || space.result.state === 'denied' || space.result.state === 'retired') ?
      <Button className="min-h-11" variant="outline" onClick={space.retry}>{m.library_follow_retry()}</Button> : null}
    {destination ? <div className="space-y-2">
      <a className={buttonVariants({ variant: 'default', className: 'min-h-11 max-w-full whitespace-normal break-words' })} href={destination.href}
        onClick={event => { if (!selection.current() || (isSpace && !space.current())) event.preventDefault(); }}>
        {destination.kind === 'realm' ? m.following_reading_open_realm() : m.following_reading_open({ title: ready?.title ?? title.text })}
      </a>
      <p className="text-sm text-muted-foreground">{m.following_reading_destination_admission()}</p>
    </div> : (!isSpace || ready) ? <p role="status">{m.following_reading_no_destination()}</p> : null}
    <dl className="space-y-3">
      <FollowingReference label={follow.targetType === 'space' ? m.following_reading_space_id() : follow.targetType === 'collection' ? m.following_reading_collection_id() : m.following_reading_subject_id()}
        value={follow.targetId} current={selection.current} />
      {ready?.address ? <FollowingReference label={m.following_reading_space_address()} value={ready.address} current={space.current} /> : null}
      {ready?.realmId ? <FollowingReference label={m.following_reading_realm_id()} value={ready.realmId} current={space.current} /> : null}
    </dl>
    <Button className="min-h-11" variant="outline" onClick={close}>{m.following_reading_return_controls()}</Button>
  </section>;
}
