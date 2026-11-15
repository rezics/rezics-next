import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale, locales } from '../../paraglide/runtime.js';
import type { ZoneLifecycleResult } from './lifecycle-zone-commands.ts';

export {
  changeZoneLifecycle,
  changeZoneTakedown,
  type ZoneLifecycleAddress,
  type ZoneLifecycleClient,
  type ZoneLifecycleFailure,
  type ZoneLifecycleResult,
  type ZoneTakedownCommand,
} from './lifecycle-zone-commands.ts';

export function ZoneLifecycleControls(props: {
  locale?: string;
  deleted: boolean;
  withheld: boolean;
  busy: boolean;
  onDelete: () => void;
  onRestore: () => void;
  onRelease?: (() => void) | undefined;
  last?: ZoneLifecycleResult | undefined;
}) {
  const options = { locale: locales.find((locale) => locale === props.locale) ?? getLocale() };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.deleted ? (
        <Button type="button" disabled={props.busy} onClick={props.onRestore}>
          {m.zone_lifecycle_restore({}, options)}
        </Button>
      ) : (
        <Button type="button" disabled={props.busy} onClick={props.onDelete}>
          {m.zone_lifecycle_delete({}, options)}
        </Button>
      )}
      {props.withheld && props.onRelease ? (
        <Button type="button" disabled={props.busy} onClick={props.onRelease}>
          {m.zone_lifecycle_release_takedown({}, options)}
        </Button>
      ) : null}
      {props.last && !props.last.ok ? (
        <p role="status" aria-live="polite">
          {props.last.reason === 'denied'
            ? m.zone_lifecycle_denied({}, options)
            : m.zone_lifecycle_failed({}, options)}
        </p>
      ) : null}
    </div>
  );
}
