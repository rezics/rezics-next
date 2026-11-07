/** Inbox feature entry for route and shell composition. */
export { InboxPageView } from './inbox-page';
export { setInboxResponsePolicy } from './inbox-read';
export type { UnreadCount } from './inbox-read';
export { UnreadBadge, UnreadBadgeView, useInboxUnreadCount } from './unread-badge';
export { InboxShellProvider, useInboxShell, createInboxShellPort, productionInboxShellPort } from './adapters/shell';
export type { InboxShellPort, InboxSessionObservation } from './ports/shell';
