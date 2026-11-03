import { m } from '../paraglide/messages.js';

/** Explains the categories without inventing preference keys, defaults or an enabled toggle. */
export function WatchNotificationGuide() {
  return (
    <aside className="space-y-2 text-sm text-muted-foreground" aria-label={m.settings_watch_notifications_heading()}>
      <h3 className="font-medium text-foreground">{m.settings_watch_notifications_heading()}</h3>
      <p>{m.inbox_thread_activity_text()}</p>
      <p>{m.inbox_board_activity_text()}</p>
      <p>{m.settings_watch_notifications_support()}</p>
      <p>{m.settings_watch_notifications_mandatory()}</p>
    </aside>
  );
}
