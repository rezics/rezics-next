import { CONTENT_EVENTS } from './events.ts';
import { REPORT_LOCATOR_EVENTS } from './report-locator-events.ts';

/** Content's event catalogue as a declared value. Locator events belong on the same surface as
 * thread, media and moderation events; the composition root evaluates this once at start. */
export function contentDeclaredEvents() {
  return Object.freeze({
    ...CONTENT_EVENTS(),
    ...REPORT_LOCATOR_EVENTS,
  });
}
