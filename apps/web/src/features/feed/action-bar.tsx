import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import {
  CheckIcon,
  EllipsisIcon,
  FrownIcon,
  HeartIcon,
  LaughIcon,
  LibraryBigIcon,
  LightbulbIcon,
  ReplyIcon,
  Share2Icon,
  ThumbsUpIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { observeReactionSession } from '../../threads/thread-reactions';
import { VoteControl, type FeedReaction } from './vote-control';
import type { FeedItem, FeedPage } from '../pages/home-feed-read';
import { homeFeedDestination, homeFeedTitle } from '../pages/home-feed-destination';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import {
  homeFeedReaction,
  homeFeedReactionStatus,
  homeFeedSubjectReactionProjection,
  type HomeFeedReactionStatus,
} from './home-feed-reaction';
import { admittedFeedWorkId } from './home-work-library/contract';
import { HomeWorkLibraryAction } from './home-work-library/view';
import { HomePublicOwnerActions } from './home-public-owner/view';

export type FeedActionBarProps = {
  locale: string;
  title: string;
  /** Already admitted localized canonical address. Missing addresses remain unavailable. */
  href?: string | undefined;
  signedIn: boolean;
  reaction?: FeedReaction | undefined;
  /** Current exact or lower-bound count for the linked reply destination; missing means unavailable. */
  replyCount?: number | Readonly<{ kind: 'exact' | 'lower-bound'; value: number }> | undefined;
  /** Existing reaction engine presentation; feed cards keep their vote layout unless a caller opts in. */
  reactionPresentation?: 'chips' | 'vote' | 'vote-plain' | undefined;
  reactionStatus?: HomeFeedReactionStatus | undefined;
  plain?: boolean | undefined;
  /** Detail pages retain the existing reply-intent owner. */
  reply?: { onReply(): void; disabled?: boolean } | { href: string } | undefined;
  /** An existing Subject/Library control, or navigation to its admitted owner. No private row reads. */
  library?: { href: string } | { control: ReactNode } | undefined;
  /** Existing author/report menu. Its owner retains edit, erasure and report ceremonies. */
  overflow?: ReactNode;
  /** Continue and other installed actions remain owned by the caller. */
  children?: ReactNode;
  /** Detail hosts can keep the reaction/menu cluster at top right and actions beside the body. */
  layout?: 'row' | 'detail';
  /** Source owners retire retained actions synchronously when a page visit is replaced. */
  origin?: { key: string; reader?: string | null; isCurrent(): boolean } | undefined;
  /** Refresh the owning page after a source-local projection becomes available. */
  onRetry?: (() => void) | undefined;
  pageBusy?: boolean | undefined;
  /** Feed-local source value, still typed by the mounted page schema at publication time. */
  subjectReactionProjection?: unknown;
  subjectTarget?: boolean | undefined;
};

const actionClass = 'min-h-11 max-w-full whitespace-normal break-words sm:min-h-8 pointer-coarse:min-h-11';

const subjectReactionControls = [
  ['like', ThumbsUpIcon, () => m.reaction_like()],
  ['love', HeartIcon, () => m.reaction_love()],
  ['laugh', LaughIcon, () => m.reaction_laugh()],
  ['insightful', LightbulbIcon, () => m.reaction_insightful()],
  ['sad', FrownIcon, () => m.reaction_sad()],
] as const;

function subjectReactionFallback(
  projection: unknown,
  locale: string,
  signedIn: boolean,
  href: string | undefined,
  onRetry: (() => void) | undefined,
  busy: boolean,
  current: () => boolean,
) {
  const options = { locale: locale as Locale };
  const source = projection && typeof projection === 'object' ? (projection as Record<string, unknown>) : undefined;
  const counts =
    source?.counts && typeof source.counts === 'object' ? (source.counts as Record<string, unknown>) : undefined;
  const knownValues =
    counts?.state === 'available' && counts.values && typeof counts.values === 'object'
      ? (counts.values as Record<string, unknown>)
      : undefined;
  const viewer =
    source?.viewer && typeof source.viewer === 'object' ? (source.viewer as Record<string, unknown>) : undefined;
  const viewerKnown = current() && viewer?.state === 'available';
  const selected = viewerKnown ? viewer.kind : undefined;
  const signIn = `/${locale}/auth/sign-in?return_to=${encodeURIComponent(href ?? `/${locale}/`)}`;
  const signInAllowed = !signedIn && source?.action === 'sign_in' && current();
  const format = (kind: string) => {
    const raw = knownValues?.[kind];
    const count =
      knownValues && (!Object.hasOwn(knownValues, kind) || raw === undefined)
        ? 0
        : typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
          ? raw
          : undefined;
    if (count === undefined) return { visible: '—', exact: '—' };
    return {
      visible: new Intl.NumberFormat(locale, { notation: 'compact' }).format(count),
      exact: new Intl.NumberFormat(locale).format(count),
    };
  };
  return (
    <div role="group" aria-label={m.reaction_reactions({}, options)} data-slot="subject-reaction-unavailable">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {subjectReactionControls.map(([kind, Icon, label]) => {
          const count = format(kind);
          const accessibleCount = count.visible === count.exact ? count.visible : `${count.visible} (${count.exact})`;
          const name = `${label()} ${accessibleCount}`;
          const pressed = viewerKnown ? selected === kind : undefined;
          const className = `${buttonVariants({ variant: 'outline', size: 'sm' })} min-h-11 rounded-full pointer-coarse:min-h-11`;
          const content = (
            <>
              <Icon aria-hidden className="size-4" />
              <span aria-hidden className="tabular-nums">
                {count.visible}
              </span>
            </>
          );
          return signedIn || !href || !signInAllowed ? (
            <Button
              key={kind}
              type="button"
              variant="outline"
              size="sm"
              className={className}
              disabled
              aria-label={name}
              {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
            >
              {content}
            </Button>
          ) : (
            <a key={kind} href={signIn} className={className} aria-label={name}>
              {content}
            </a>
          );
        })}
        {onRetry ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={actionClass}
            disabled={busy}
            onClick={() => {
              if (!busy) onRetry();
            }}
          >
            {m.subject_section_retry({}, options)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Native feedback commands are not installed. Keep their absence explicit in the shared menu. */
export function feedFeedbackEntries(locale: string, signedIn: boolean, href: string): MenuEntry[] {
  const options = { locale: locale as Locale };
  const signIn = `/${locale}/auth/sign-in?return_to=${encodeURIComponent(href)}`;
  return [m.feed_action_mute({}, options), m.feed_action_hide({}, options)].map((label) =>
    signedIn
      ? { type: 'item', label: `${label} · ${m.feed_action_unavailable({}, options)}`, disabled: true, onSelect() {} }
      : { type: 'link', label, href: signIn },
  );
}

/** Consume only the generated feed contract. No invented reaction fields and no per-row point reads. */
export function HomeFeedActions({
  item,
  locale,
  signedIn,
  children,
  verification,
  origin,
  reactionsAsOf,
  hasReactionFreshness = false,
  onRetry,
  busy = false,
}: {
  item: FeedItem;
  locale: string;
  signedIn: boolean;
  children?: ReactNode;
  verification?: VerificationConfig | undefined;
  origin?: FeedActionBarProps['origin'];
  reactionsAsOf?: FeedPage['reactionsAsOf'];
  hasReactionFreshness?: boolean;
  onRetry?: (() => void) | undefined;
  busy?: boolean;
}) {
  const href = homeFeedDestination(item, locale);
  const kind = item.destination.kind;
  if (kind === 'collection' || kind === 'space')
    return (
      <HomePublicOwnerActions item={item} locale={locale} signedIn={signedIn}>
        {children}
      </HomePublicOwnerActions>
    );
  if (kind !== 'thread' && kind !== 'post' && kind !== 'subject') return children;
  const workId = admittedFeedWorkId(item);
  const destination = item.destination;
  const reactionOrigin = origin === undefined ? undefined : { ...origin, reader: origin.reader ?? null };
  const reaction = homeFeedReaction(item, {
    signedIn,
    ...(reactionOrigin === undefined ? {} : { origin: reactionOrigin }),
    reactionsAsOf,
    hasReactionFreshness,
  });
  const reactionStatus = homeFeedReactionStatus(item, {
    signedIn,
    reaction,
    ...(reactionOrigin === undefined ? {} : { origin: reactionOrigin }),
  });
  const target =
    destination.kind === 'thread' || destination.kind === 'subject'
      ? { kind: destination.kind, id: destination.id }
      : destination.kind === 'post'
        ? { kind: 'post' as const, id: destination.postId }
        : undefined;
  return (
    <FeedActionBar
      locale={locale}
      href={href}
      title={homeFeedTitle(item, locale)}
      signedIn={signedIn}
      reaction={reaction}
      reactionStatus={reactionStatus}
      reactionPresentation={kind === 'subject' ? 'chips' : undefined}
      subjectReactionProjection={homeFeedSubjectReactionProjection(item)}
      subjectTarget={kind === 'subject'}
      onRetry={onRetry}
      pageBusy={busy}
      plain={kind === 'post'}
      origin={origin}
      overflow={
        target && verification && href ? (
          <PostActions
            target={target}
            verification={verification}
            canonicalHref={href}
            extraEntries={feedFeedbackEntries(locale, signedIn, href)}
          />
        ) : undefined
      }
      reply={
        (kind === 'thread' || kind === 'post') && href
          ? { href: `${href}${href.includes('#') ? '' : '#reply'}` }
          : undefined
      }
      library={
        workId && href
          ? {
              control: (
                <HomeWorkLibraryAction
                  rowKey={item.id}
                  subjectId={workId}
                  href={`${href}?slot=collections`}
                  locale={locale}
                  signedIn={signedIn}
                />
              ),
            }
          : undefined
      }
    >
      {children}
    </FeedActionBar>
  );
}

/** One exported card port. It renders supplied state and never hydrates rows or creates a mutation engine. */
export function FeedActionBar(props: FeedActionBarProps) {
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => observeReactionSession(client), [client]);
  const revision = useSyncExternalStore(observation.subscribe, observation.snapshot, observation.serverSnapshot);
  const [provider, setProvider] = useState({ observation, visit: 0 });
  if (provider.observation !== observation) setProvider({ observation, visit: provider.visit + 1 });
  const identity = JSON.stringify([
    props.href,
    props.signedIn,
    props.origin?.key,
    props.reaction?.target,
    JSON.stringify(props.subjectReactionProjection ?? null),
    props.subjectTarget ?? false,
    props.reactionStatus ?? null,
    revision,
    provider.visit,
  ]);
  const desired = useRef(identity);
  desired.current = identity;
  return (
    <ActionVisit
      key={identity}
      {...props}
      isCurrent={() =>
        desired.current === identity && observation.snapshot() === revision && (props.origin?.isCurrent() ?? true)
      }
    />
  );
}

function ActionVisit({
  locale,
  href,
  title,
  signedIn,
  reaction,
  reactionStatus,
  replyCount,
  reactionPresentation,
  plain,
  reply,
  library,
  overflow,
  children,
  layout = 'row',
  origin,
  onRetry,
  pageBusy = false,
  subjectReactionProjection,
  subjectTarget = false,
  isCurrent,
}: FeedActionBarProps & { isCurrent(): boolean }) {
  const options = { locale: locale as Locale };
  const replyCountOperand =
    typeof replyCount === 'number'
      ? { kind: 'exact' as const, value: replyCount }
      : typeof replyCount === 'object' &&
          replyCount !== null &&
          (replyCount.kind === 'exact' || replyCount.kind === 'lower-bound')
        ? replyCount
        : undefined;
  const safeReplyCount =
    replyCountOperand && Number.isSafeInteger(replyCountOperand.value) && replyCountOperand.value >= 0
      ? replyCountOperand.value
      : undefined;
  const replyCountIsLowerBound = replyCountOperand?.kind === 'lower-bound';
  const replyLabel = m.feed_action_reply({}, options);
  const exactReplyCount =
    safeReplyCount === undefined
      ? undefined
      : `${new Intl.NumberFormat(locale).format(safeReplyCount)}${replyCountIsLowerBound ? '+' : ''}`;
  const compactReplyCount =
    safeReplyCount === undefined
      ? undefined
      : `${new Intl.NumberFormat(locale, { notation: 'compact' }).format(safeReplyCount)}${replyCountIsLowerBound ? '+' : ''}`;
  const replyName = exactReplyCount === undefined ? replyLabel : `${replyLabel} ${exactReplyCount}`;
  const replyContent = (
    <>
      <ReplyIcon aria-hidden />
      <span>{replyLabel}</span>
      {compactReplyCount === undefined ? null : (
        <span aria-hidden className="tabular-nums">
          {compactReplyCount}
        </span>
      )}
    </>
  );
  const [feedback, setFeedback] = useState<'copied' | 'manual' | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const running = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<'share' | 'menu'>('share');
  const fieldId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current++;
    };
  }, []);
  useEffect(() => {
    if (feedback !== 'manual') return;
    // Menu dismissal restores its trigger first; then the explicit recovery takes focus.
    const frame = requestAnimationFrame(() => {
      if (mounted.current && isCurrent()) {
        field.current?.focus();
        field.current?.select();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [feedback, manualUrl]);
  const current = () => mounted.current && isCurrent();
  const signIn = `/${locale}/auth/sign-in?return_to=${encodeURIComponent(href ?? `/${locale}/`)}`;
  const available = origin?.isCurrent() ?? true;
  const activeOverflow = signedIn ? overflow : undefined;
  const shareLabel = <span className="sr-only sm:not-sr-only">{m.thread_reading_share({}, options)}</span>;
  const shareClass = `${actionClass} min-w-11 px-2 sm:min-w-8`;

  async function share(native: boolean) {
    if (!href || !current() || running.current) return;
    const url = new URL(href, window.location.origin).href;
    const ticket = ++attempt.current;
    const active = () => current() && attempt.current === ticket;
    returnFocus.current = native ? 'share' : 'menu';
    running.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      if (native && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title, url });
          return;
        } catch (error) {
          // A deliberate dismissal is not a successful share or a clipboard request.
          if (error instanceof Error && error.name === 'AbortError') return;
          if (!active()) return;
        }
      }
      await navigator.clipboard.writeText(url);
      if (active()) setFeedback('copied');
    } catch {
      if (active()) {
        setManualUrl(url);
        setFeedback('manual');
      }
    } finally {
      running.current = false;
      if (active()) setBusy(false);
    }
  }

  const unavailable = m.feed_action_unavailable({}, options);
  const gatedEntry = (label: string): MenuEntry =>
    signedIn
      ? { type: 'item', label: `${label} · ${unavailable}`, disabled: true, onSelect() {} }
      : { type: 'link', label, href: signIn };
  const entries: MenuEntry[] = [
    gatedEntry(m.report_action({}, options)),
    ...feedFeedbackEntries(locale, signedIn, href ?? `/${locale}/`),
    { type: 'separator' },
    signedIn
      ? {
          type: 'item',
          label: m.report_copy({}, options),
          disabled: !href || !available || busy,
          onSelect: () => {
            void share(false);
          },
        }
      : { type: 'link', label: m.report_copy({}, options), href: signIn },
  ];
  const actions = (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" data-slot="feed-secondary-actions">
      {!signedIn ? (
        <a
          href={signIn}
          aria-label={replyName}
          data-slot="feed-reply-action"
          className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} ${actionClass}`}
        >
          {replyContent}
        </a>
      ) : reply && 'onReply' in reply ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={actionClass}
          aria-label={replyName}
          data-slot="feed-reply-action"
          disabled={reply.disabled || !available}
          onClick={() => {
            if (current()) reply.onReply();
          }}
        >
          {replyContent}
        </Button>
      ) : reply && 'href' in reply ? (
        <a
          href={reply.href}
          aria-label={replyName}
          data-slot="feed-reply-action"
          className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} ${actionClass}`}
        >
          {replyContent}
        </a>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={actionClass}
          aria-label={replyName}
          data-slot="feed-reply-action"
          disabled
          title={unavailable}
        >
          {replyContent}
        </Button>
      )}
      {!signedIn ? (
        <a href={signIn} className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} ${shareClass}`}>
          <Share2Icon aria-hidden />
          {shareLabel}
        </a>
      ) : (
        <Button
          ref={shareButton}
          type="button"
          variant="ghost"
          size="sm"
          className={shareClass}
          disabled={!href || !available || busy}
          aria-busy={busy}
          onClick={() => {
            void share(true);
          }}
        >
          {feedback === 'copied' ? <CheckIcon aria-hidden className="text-primary" /> : <Share2Icon aria-hidden />}
          {shareLabel}
        </Button>
      )}
      {library ? (
        'control' in library ? (
          library.control
        ) : (
          <a
            href={signedIn ? library.href : signIn}
            className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} ${actionClass}`}
          >
            <LibraryBigIcon aria-hidden />
            {m.feed_action_library({}, options)}
          </a>
        )
      ) : null}
      {children}
    </div>
  );
  return (
    <div
      data-slot="feed-action-bar"
      className={`relative z-10 flex min-w-0 max-w-full flex-wrap items-center gap-1 ${layout === 'detail' ? 'justify-end' : ''}`}
    >
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" data-slot="feed-reaction-cluster">
        {reaction ? (
          <VoteControl
            reaction={reaction}
            signedIn={signedIn}
            href={href}
            locale={locale}
            plain={plain}
            presentation={reactionPresentation}
          />
        ) : subjectTarget ? (
          subjectReactionFallback(subjectReactionProjection, locale, signedIn, href, onRetry, busy || pageBusy, current)
        ) : (
          <VoteControl
            reaction={reaction}
            signedIn={signedIn}
            href={href}
            locale={locale}
            plain={plain}
            presentation={reactionPresentation}
          />
        )}
        {layout === 'detail'
          ? (activeOverflow ?? (
              <Menu
                title={m.report_more({}, options)}
                entries={entries}
                trigger={
                  <Button
                    ref={menuButton}
                    variant="ghost"
                    size="icon"
                    className={actionClass}
                    aria-label={m.report_more({}, options)}
                  >
                    <EllipsisIcon aria-hidden />
                  </Button>
                }
              />
            ))
          : null}
      </div>
      {actions}
      {layout === 'row'
        ? (activeOverflow ?? (
            <Menu
              title={m.report_more({}, options)}
              entries={entries}
              trigger={
                <Button
                  ref={menuButton}
                  variant="ghost"
                  size="icon"
                  className={`${actionClass} min-w-11 sm:min-w-8 pointer-coarse:min-w-11`}
                  aria-label={m.report_more({}, options)}
                >
                  <EllipsisIcon aria-hidden />
                </Button>
              }
            />
          ))
        : null}
      {reactionStatus ? (
        <div data-slot="feed-reaction-admission" className="basis-full min-w-0 text-sm text-muted-foreground">
          <p>{reactionStatus === 'denied' ? m.reaction_forbidden({}, options) : m.reaction_unavailable({}, options)}</p>
          {reactionStatus === 'unavailable' && onRetry && (!subjectTarget || reaction) ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionClass}
              disabled={pageBusy}
              onClick={() => {
                if (!pageBusy && isCurrent()) onRetry();
              }}
            >
              {m.subject_section_retry({}, options)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {feedback ? (
        <div className="basis-full min-w-0 space-y-2 text-sm">
          <p id={descriptionId} role="status">
            {feedback === 'copied'
              ? m.report_copy_success({}, options)
              : m.report_copy_recovery_description({}, options)}
          </p>
          {feedback === 'manual' ? (
            <>
              <label htmlFor={fieldId}>{m.report_copy_recovery_link_label({}, options)}</label>
              <Input
                id={fieldId}
                ref={field}
                readOnly
                dir="ltr"
                value={manualUrl}
                aria-describedby={descriptionId}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                onClick={() => {
                  setFeedback(null);
                  (returnFocus.current === 'share' ? shareButton : menuButton).current?.focus();
                }}
              >
                {m.report_copy_recovery_close({}, options)}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
