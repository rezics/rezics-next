import { Button } from '@rezics/ui/shadcn/button';
import type { ZoneLifecycleResult } from './lifecycle-zone';

export function ZoneLifecycleControls(props: {
  deleted: boolean;
  withheld: boolean;
  busy: boolean;
  onDelete: () => void;
  onRestore: () => void;
  onRelease?: () => void;
  last?: ZoneLifecycleResult;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.deleted ? (
        <Button type="button" disabled={props.busy} onClick={props.onRestore}>
          Restore zone
        </Button>
      ) : (
        <Button type="button" disabled={props.busy} onClick={props.onDelete}>
          Delete zone
        </Button>
      )}
      {props.withheld && props.onRelease ? (
        <Button type="button" disabled={props.busy} onClick={props.onRelease}>
          Release takedown
        </Button>
      ) : null}
      {props.last && !props.last.ok ? (
        <p role="status" aria-live="polite">
          {props.last.reason === 'denied' ? 'Not allowed' : 'Could not update the zone'}
        </p>
      ) : null}
    </div>
  );
}
