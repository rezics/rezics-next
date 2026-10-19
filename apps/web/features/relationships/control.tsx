'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuTrigger,
} from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  EllipsisIcon,
  PinIcon,
  PlusIcon,
  VolumeXIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { ReportMenu, ReportMenuItems, type ReportMenuTarget } from '../safety/report-action.tsx';
import { mainRelationships, RelationshipError } from './api.ts';
import { observeRelationships } from './events.ts';
import { messages } from './messages.ts';
import type { FollowEdit, FollowState, Level, RelationshipsApi } from './types.ts';

/** A notification choice always edits the current relationship; omitted fields remain Main's responsibility. */
export function NotificationMenu({
  locale,
  level,
  busy,
  onChange,
  watch = false,
}: {
  locale: UiLocale;
  level: string;
  busy: boolean;
  onChange: (level: Level) => void;
  watch?: boolean;
}) {
  const t = messages[locale];
  const label =
    level === 'all'
      ? t.all
      : level === 'highlights'
        ? watch
          ? t.participating
          : t.highlights
        : t.off;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={busy}
          aria-label={`${t.notifications}: ${label}`}
          title={`${t.notifications}: ${label}`}
        >
          {level === 'off' ? <BellOffIcon aria-hidden="true" /> : <BellIcon aria-hidden="true" />}
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup value={level} onValueChange={(details) => onChange(details.value as Level)}>
          <MenuRadioItem value="all">{t.all}</MenuRadioItem>
          <MenuRadioItem value="highlights">{watch ? t.participating : t.highlights}</MenuRadioItem>
          <MenuRadioItem value="off">{t.off}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** The reaction group excludes the object's more menu so each keeps its own accessible identity. */
function Reactions({ label, children }: { label?: string; children: ReactNode }) {
  return label ? <div role="group" aria-label={label} className="flex min-w-0 items-center gap-1.5">{children}</div> : children;
}

/** Follow/Join, its delivery level and separate negative relationships share one control on every surface. */
export function RelationshipControl(props: Parameters<typeof RelationshipControlState>[0]) {
  return (
    <RelationshipControlState
      key={`${props.target}:${props.kind}:${props.signedIn}:${props.actingSubject ?? 'guest'}`}
      {...props}
    />
  );
}

function RelationshipControlState({
  target,
  kind,
  name,
  locale,
  signedIn,
  actingSubject,
  signInHref,
  initial,
  api: supplied,
  membership,
  realm,
  onChange,
  className,
  compact = false,
  followLabel,
  followingLabel,
  followAccessibleLabel,
  moreAccessibleLabel,
  reactionsLabel,
  reports = [],
}: {
  target: string;
  kind: string;
  name: string;
  locale: UiLocale;
  signedIn: boolean;
  actingSubject?: string | null;
  signInHref: string;
  initial?: FollowState | null;
  api?: RelationshipsApi;
  realm?: string | null;
  membership?: { joined: boolean; join?: () => void; leave?: () => void };
  onChange?: (state: FollowState) => void;
  className?: string;
  compact?: boolean;
  followLabel?: string;
  followingLabel?: string;
  followAccessibleLabel?: string;
  moreAccessibleLabel?: string;
  reactionsLabel?: string;
  reports?: readonly ReportMenuTarget[];
}) {
  const t = messages[locale];
  const api = useMemo(
    () => supplied ?? (actingSubject ? mainRelationships(actingSubject) : null),
    [supplied, actingSubject],
  );
  const apiRef = useRef(api);
  apiRef.current = api;
  const [state, setState] = useState<FollowState | null>(initial ?? null);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [negative, setNegative] = useState<'muted' | 'blocked' | null>(null);
  const retry = useRef<{ intent: string; key: string; edit: FollowEdit } | null>(null);
  const readGeneration = useRef(0);
  const readerScope = useRef(api);
  useEffect(() => {
    setHydrated(true);
  }, []);
  useEffect(() => {
    const changedReader = readerScope.current !== apiRef.current;
    readerScope.current = apiRef.current;
    if (changedReader) {
      setState(null);
      setNegative(null);
      retry.current = null;
    }
    if (!signedIn || !apiRef.current) return;
    let active = true;
    const refresh = () => {
      const generation = ++readGeneration.current;
      // Main derives the follow identity; a surface's type can differ from its canonical kind (for example Projection).
      void apiRef
        .current!.state(target)
        .then((fresh) => {
          if (active && generation === readGeneration.current) {
            setState(fresh);
            setNotice(null);
          }
        })
        .catch(() => {
          if (active && generation === readGeneration.current) setNotice(t.unavailable);
        });
    };
    // Older route adapters pass only following/revision; read the level, source and pin before presenting them.
    if (changedReader || !initial || initial.following === null || initial.level === null)
      refresh();
    const stop = observeRelationships(refresh);
    return () => {
      active = false;
      readGeneration.current++;
      stop();
    };
  }, [target, kind, signedIn, actingSubject, supplied, t.unavailable]);

  async function write(edit: { following?: boolean; level?: Level; pinPosition?: number | null }) {
    if (busy || !state || state.following === null || !apiRef.current) return;
    const writer = apiRef.current;
    const intent = JSON.stringify(edit);
    const pending =
      retry.current?.intent === intent
        ? retry.current
        : {
            intent,
            key: crypto.randomUUID(),
            edit: { target, expectedRevision: state.revision, ...edit },
          };
    retry.current = pending;
    setBusy(true);
    setNotice(null);
    try {
      // Metadata edits omit following: Main preserves join/library provenance rather than promoting them to explicit follows.
      const result =
        edit.following === undefined
          ? (await writer.batch([pending.edit], pending.key)).items[0]
          : await writer.set(
              pending.edit as FollowEdit & { following: boolean; expectedRevision: string | null },
              pending.key,
            );
      if (writer !== apiRef.current) return;
      if (!result) throw new Error('Incomplete relationship receipt');
      readGeneration.current++;
      const next = {
        following: result.following,
        revision: result.revision,
        level: result.level,
        source: result.source,
        pinPosition: result.pinPosition,
      };
      setState(next);
      onChange?.(next);
      retry.current = null;
    } catch (error) {
      if (writer !== apiRef.current) return;
      if (error instanceof RelationshipError && error.status === 409) {
        retry.current = null;
        try {
          setState(await writer.state(target));
        } catch {
          /* Preserve the last known state. */
        }
        setNotice(t.stale);
      } else setNotice(t.failed);
    } finally {
      setBusy(false);
    }
  }
  const muteKind =
    kind === 'agent'
      ? 'person'
      : kind === 'concept'
        ? 'tag'
        : kind === 'realm' || ((kind === 'space' || kind === 'zone') && realm)
          ? 'realm'
          : null;
  async function negativeAction(action: 'mute' | 'block') {
    if (busy || !apiRef.current) return;
    setBusy(true);
    setNotice(null);
    try {
      if (action === 'mute' && muteKind)
        await apiRef.current.mute(
          muteKind === 'realm' ? (realm ?? target) : target,
          muteKind,
          true,
        );
      else if (action === 'block' && kind === 'agent') await apiRef.current.block(target, true);
      else return;
      setNegative(action === 'mute' ? 'muted' : 'blocked');
    } catch {
      setNotice(t.failed);
    } finally {
      setBusy(false);
    }
  }
  const primary = membership?.joined
    ? t.joined
    : membership?.join
      ? t.join
      : state?.following
        ? (followingLabel ?? t.following)
        : (followLabel ?? t.follow);
  if (!signedIn)
    return (
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"><Reactions label={reactionsLabel}><a
        href={signInHref}
        aria-label={followAccessibleLabel ? `${followAccessibleLabel} · ${t.signIn}` : undefined}
        className={cn(buttonVariants({ pill: true, size: compact ? 'xs' : 'sm' }), 'w-fit max-w-full justify-self-start', className)}
      >
        <PlusIcon aria-hidden="true" />
        {membership ? t.join : (followLabel ?? t.follow)}
        <span className="sr-only">
          {' '}
          · {name} · {t.signIn}
        </span>
      </a></Reactions><ReportMenu targets={reports} name={name} locale={locale} moreAccessibleLabel={moreAccessibleLabel} /></div>
    );
  if (!api)
    return (
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"><Reactions label={reactionsLabel}><p role="status" className="text-muted-foreground text-sm">
        {t.unknown}
      </p></Reactions><ReportMenu targets={reports} name={name} locale={locale} moreAccessibleLabel={moreAccessibleLabel} /></div>
    );
  return (
    <div
      className={cn('flex w-fit min-w-0 max-w-full flex-wrap items-center gap-1.5 justify-self-start', className)}
      data-relationship={target}
      data-hydrated={hydrated ? 'true' : undefined}
    >
      <Reactions label={reactionsLabel}>
      <Button
        type="button"
        pill
        size={compact ? 'xs' : 'sm'}
        variant={state?.following || membership?.joined ? 'outline' : 'default'}
        aria-label={!state?.following && !membership ? followAccessibleLabel : undefined}
        isLoading={busy}
        disabled={
          !hydrated ||
          busy ||
          (membership?.joined && !membership.leave) ||
          (!membership?.join && !membership?.joined && state?.following == null)
        }
        onClick={() =>
          membership?.joined
            ? membership.leave?.()
            : membership?.join
              ? membership.join()
              : void write({ following: !state?.following })
        }
      >
        {state?.following || membership?.joined ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <PlusIcon aria-hidden="true" />
        )}
        {primary}
        <span className="sr-only">
          {' '}
          · {name}
          {membership?.joined && membership.leave
            ? ` · ${t.leave}`
            : state?.following && !membership?.joined && !membership?.join
              ? ` · ${t.unfollow}`
              : ''}
        </span>
      </Button>
      {state?.following && state.level ? (
        <NotificationMenu
          locale={locale}
          level={state.level}
          busy={busy || !hydrated}
          onChange={(level) => void write({ level })}
        />
      ) : null}
      </Reactions>
      <Menu>
        <MenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={moreAccessibleLabel ?? `${t.options} · ${name}`}
          >
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent className="max-w-[calc(100vw-2rem)]">
          {reports.length ? <><ReportMenuItems targets={reports} locale={locale} /><MenuSeparator /></> : null}
          {membership ? (
            <MenuItem
              value="follow"
              disabled={busy || !hydrated || state?.following == null}
              onSelect={() => void write({ following: !state?.following })}
            >
              {state?.following ? t.unfollow : t.explicitFollow}
            </MenuItem>
          ) : null}
          {membership && state?.following && state.source === 'join' ? (
            <MenuItem value="explicit" disabled={busy || !hydrated} onSelect={() => void write({ following: true })}>
              {t.explicitFollow}
            </MenuItem>
          ) : null}
          <MenuItem
            value="pin"
            disabled={busy || !hydrated || !state?.following}
            onSelect={() => void write({ pinPosition: state?.pinPosition === null ? 0 : null })}
          >
            <PinIcon aria-hidden="true" />
            {state?.pinPosition != null ? t.unpin : t.pin}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            value="mute"
            title={!muteKind ? t.unsupported : undefined}
            disabled={busy || !hydrated || !muteKind || negative === 'muted'}
            onSelect={() => void negativeAction('mute')}
          >
            <VolumeXIcon aria-hidden="true" />
            {t.mute}
          </MenuItem>
          <MenuItem
            value="block"
            title={kind !== 'agent' ? t.unsupported : undefined}
            disabled={busy || !hydrated || kind !== 'agent' || negative === 'blocked'}
            onSelect={() => void negativeAction('block')}
          >
            {t.block}
          </MenuItem>
        </MenuContent>
      </Menu>
      {negative ? (
        <span role="status" className="text-muted-foreground text-xs">
          {t[negative]}
        </span>
      ) : null}
      {notice ? (
        <p role="status" className="basis-full text-destructive-foreground text-xs">
          {notice}
        </p>
      ) : null}
      {!state && !notice ? (
        <span role="status" className="text-muted-foreground text-xs">
          {t.loading}
        </span>
      ) : null}
      {notice === t.unavailable ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            void api
              .state(target)
              .then((fresh) => {
                setState(fresh);
                setNotice(null);
              })
              .catch(() => setNotice(t.unavailable));
          }}
        >
          {t.retry}
        </Button>
      ) : null}
    </div>
  );
}
