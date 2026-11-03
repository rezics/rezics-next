/** Append content notification kinds here; the catalogue is bounded to 32 entries. */
export const NOTIFICATION_KINDS = Object.freeze([
  Object.freeze({ kind: 'reply', optional: true, default: true } as const),
  Object.freeze({ kind: 'mention', optional: true, default: true } as const),
  Object.freeze({ kind: 'thread_watch', optional: true, default: true } as const),
  Object.freeze({ kind: 'board_activity', optional: true, default: true } as const),
  Object.freeze({ kind: 'moderation_decision', optional: false, default: true } as const),
] as const);

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]['kind'];
export type OptionalNotificationKind = Extract<(typeof NOTIFICATION_KINDS)[number], { optional: true }>['kind'];
export type Notifications = Record<OptionalNotificationKind, boolean>;
export type NotificationsPatch = Partial<Record<OptionalNotificationKind, boolean | null>>;

if (
  NOTIFICATION_KINDS.length > 32 ||
  new Set(NOTIFICATION_KINDS.map(({ kind }) => kind)).size !== NOTIFICATION_KINDS.length ||
  NOTIFICATION_KINDS.some(({ kind }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(kind))
)
  throw new TypeError('Invalid notification kind catalogue');

export const DEFAULT_NOTIFICATIONS: Readonly<Notifications> = Object.freeze(
  Object.fromEntries(NOTIFICATION_KINDS.filter(({ optional }) => optional).map((entry) => [entry.kind, entry.default])),
) as Notifications;
