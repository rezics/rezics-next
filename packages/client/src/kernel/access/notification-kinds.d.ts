/** Append content notification kinds here; the catalogue is bounded to 32 entries. */
export declare const NOTIFICATION_KINDS: readonly [Readonly<{
    readonly kind: 'reply';
    readonly optional: true;
    readonly default: true;
}>, Readonly<{
    readonly kind: 'mention';
    readonly optional: true;
    readonly default: true;
}>, Readonly<{
    readonly kind: 'moderation_decision';
    readonly optional: false;
    readonly default: true;
}>];
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]['kind'];
export type OptionalNotificationKind = Extract<(typeof NOTIFICATION_KINDS)[number], {
    optional: true;
}>['kind'];
export type Notifications = Record<OptionalNotificationKind, boolean>;
export type NotificationsPatch = Partial<Record<OptionalNotificationKind, boolean | null>>;
export declare const DEFAULT_NOTIFICATIONS: Readonly<Notifications>;
