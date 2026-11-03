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
import { CheckIcon, EllipsisIcon, LibraryBigIcon, ReplyIcon, Share2Icon } from 'lucide-react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { observeReactionSession } from '../../threads/thread-reactions';
import { VoteControl, type FeedReaction } from './vote-control';
import type { FeedItem } from '../pages/home-feed-read';
import { homeFeedDestination, homeFeedTitle } from '../pages/home-feed-destination';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';

export type FeedActionBarProps = {
  locale: string;
  title: string;
  /** Already admitted localized canonical address. Missing addresses remain unavailable. */
  href?: string | undefined;
  signedIn: boolean;
  reaction?: FeedReaction | undefined;
  /** Existing reaction engine presentation; feed cards keep their vote layout unless a caller opts in. */
  reactionPresentation?: 'chips' | 'vote' | 'vote-plain' | undefined;
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
  origin?: { key: string; isCurrent(): boolean } | undefined;
};

const actionClass = 'min-h-11 max-w-full whitespace-normal break-words sm:min-h-8 pointer-coarse:min-h-11';

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
}: {
  item: FeedItem;
  locale: string;
  signedIn: boolean;
  children?: ReactNode;
  verification?: VerificationConfig | undefined;
  origin?: FeedActionBarProps['origin'];
}) {
  const href = homeFeedDestination(item, locale);
  const kind = item.destination.kind;
  if (kind !== 'thread' && kind !== 'post' && kind !== 'subject') return children;
  const isWork = kind === 'subject' && 'creativeWork' in item.summary && item.summary.creativeWork;
  const destination = item.destination;
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
      library={isWork && href ? { href: `${href}?slot=collections` } : undefined}
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
  reactionPresentation,
  plain,
  reply,
  library,
  overflow,
  children,
  layout = 'row',
  origin,
  isCurrent,
}: FeedActionBarProps & { isCurrent(): boolean }) {
  const options = { locale: locale as Locale };
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
        <a href={signIn} className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} ${actionClass}`}>
          <ReplyIcon aria-hidden />
          {m.feed_action_reply({}, options)}
        </a>
      ) : reply && 'onReply' in reply ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={actionClass}
          disabled={reply.disabled || !available}
          onClick={() => {
            if (current()) reply.onReply();
          }}
        >
          <ReplyIcon aria-hidden />
          {m.feed_action_reply({}, options)}
        </Button>
      ) : reply && 'href' in reply ? (
        <a href={reply.href} className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} ${actionClass}`}>
          <ReplyIcon aria-hidden />
          {m.feed_action_reply({}, options)}
        </a>
      ) : (
        <Button variant="ghost" size="sm" className={actionClass} disabled title={unavailable}>
          <ReplyIcon aria-hidden />
          {m.feed_action_reply({}, options)}
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
        <VoteControl
          reaction={reaction}
          signedIn={signedIn}
          href={href}
          locale={locale}
          plain={plain}
          presentation={reactionPresentation}
        />
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
