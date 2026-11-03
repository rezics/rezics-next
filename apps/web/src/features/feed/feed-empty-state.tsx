import type { ReactNode } from 'react';
import { EmptyState } from '@rezics/ui/empty-state';
import {
  CircleHelpIcon,
  CompassIcon,
  FilterIcon,
  KeyRoundIcon,
  ListEndIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  UsersIcon,
} from 'lucide-react';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { FeedResultsAvailability, FeedResultsMessages } from './feed-results';

export type FeedEmptyKind =
  | 'empty'
  | 'sparse'
  | 'partial'
  | 'loading'
  | 'request'
  | 'auth'
  | 'denied'
  | 'closed'
  | 'cursor'
  | 'deadline'
  | 'unavailable';
export type FeedEmptyContext = 'discovery' | 'following' | 'continuation' | 'filtered';
export type FeedEmptyExplanation = { title: ReactNode; description?: ReactNode };

/** One bounded pass over supplied statuses. No source discovery or data access. */
export function feedAvailability(availability: FeedResultsAvailability) {
  let partial = availability.state !== 'complete';
  const sources: string[] = [];
  for (const [source, state] of Object.entries(availability.sources ?? {})) {
    if (state === 'not_requested') continue;
    sources.push(`${source}:${state}`);
    if (state === 'preparing' || state === 'unavailable') partial = true;
  }
  return { partial, sources: availability.sources ? sources.join(' ') : undefined };
}

const icons = {
  empty: SearchIcon,
  sparse: ListEndIcon,
  partial: CircleHelpIcon,
  loading: LoaderCircleIcon,
  request: TriangleAlertIcon,
  auth: KeyRoundIcon,
  denied: LockKeyholeIcon,
  closed: LockKeyholeIcon,
  cursor: RefreshCwIcon,
  deadline: TriangleAlertIcon,
  unavailable: CircleHelpIcon,
};

/** Feed composition only. Caller-owned actions and row presentation remain independent. */
export function FeedEmptyState({
  kind,
  messages,
  actions,
  headingLevel = 2,
  context,
}: {
  kind: FeedEmptyKind;
  messages: FeedResultsMessages;
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  context?: FeedEmptyContext;
}) {
  const explanation = messages.explanations?.[kind];
  const title = explanation?.title ?? (kind in messages.failure
    ? messages.failure[kind as keyof typeof messages.failure]
    : messages[kind as 'empty' | 'sparse' | 'partial' | 'loading']);
  const Icon = kind === 'empty' && context
    ? { discovery: CompassIcon, following: UsersIcon, continuation: ListEndIcon, filtered: FilterIcon }[context]
    : icons[kind];
  const alert = kind === 'request' || kind === 'denied' || kind === 'cursor' || kind === 'deadline' || kind === 'unavailable';
  return (
    <div data-feed-empty-state={kind} data-feed-empty-context={context}>
      <EmptyState
        title={title}
        description={explanation?.description}
        icon={<Icon />}
        actions={actions}
        headingLevel={headingLevel}
        role={alert ? 'alert' : 'status'}
        density={kind === 'loading' ? 'compact' : 'page'}
        tone={alert || kind === 'partial' ? 'attention' : 'default'}
      />
    </div>
  );
}

/** Shared Home copy for route consumers and visibly prepared recovery stories. */
export function homeFeedRecoveryMessages(locale: string, context: FeedEmptyContext): FeedResultsMessages {
  const options = { locale: locale as Locale };
  const empty = {
    discovery: { title: m.home_empty_discovery_title({}, options), description: m.home_feed_empty({}, options) },
    following: { title: m.home_empty_following_title({}, options), description: m.home_feed_following_empty({}, options) },
    continuation: { title: m.home_empty_end_title({}, options), description: m.home_empty_end_body({}, options) },
    filtered: { title: m.home_empty_filtered_title({}, options), description: m.home_empty_filtered_body({}, options) },
  }[context];
  return {
    loading: m.home_feed_loading({}, options),
    partial: m.home_presentation_partial({}, options),
    empty: empty.description,
    sparse: m.home_feed_sparse({}, options),
    retry: m.library_follow_retry({}, options),
    restart: m.home_feed_restart({}, options),
    failure: {
      request: m.home_feed_request({}, options),
      auth: m.home_feed_auth({}, options),
      denied: m.home_feed_denied({}, options),
      closed: m.home_feed_closed({}, options),
      cursor: m.home_feed_cursor({}, options),
      deadline: m.home_feed_deadline({}, options),
      unavailable: m.home_feed_unavailable({}, options),
    },
    explanations: {
      empty,
      sparse: { title: m.home_empty_sparse_title({}, options), description: m.home_feed_sparse({}, options) },
      partial: { title: m.home_empty_partial_title({}, options), description: m.home_empty_partial_body({}, options) },
      loading: { title: m.home_feed_loading({}, options), description: m.home_empty_loading_body({}, options) },
      request: { title: m.home_empty_request_title({}, options), description: m.home_feed_request({}, options) },
      auth: { title: m.account_sign_in({}, options), description: m.home_feed_auth({}, options) },
      denied: { title: m.home_empty_denied_title({}, options), description: m.home_feed_denied({}, options) },
      closed: { title: m.home_empty_closed_title({}, options), description: m.home_feed_closed({}, options) },
      cursor: { title: m.home_empty_cursor_title({}, options), description: m.home_feed_cursor({}, options) },
      deadline: { title: m.home_empty_deadline_title({}, options), description: m.home_feed_deadline({}, options) },
      unavailable: { title: m.home_feed_unavailable({}, options), description: m.home_empty_unavailable_body({}, options) },
    },
  };
}
