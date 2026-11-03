import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

const control =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words px-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function WorkbenchHistoryUnavailable({
  onReturn,
  onRetry,
}: {
  onReturn: () => void;
  onRetry?: () => void;
}) {
  return (
    <section className="space-y-3" aria-labelledby="workbench-history-heading">
      <h2 id="workbench-history-heading" className="text-xl font-semibold">
        {m.moderation_workbench_history()}
      </h2>
      <p role="alert" className="max-w-prose text-muted-foreground">
        {m.moderation_workbench_history_unavailable()}
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {onRetry ? (
          <Button type="button" variant="outline" className={control} onClick={onRetry}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
        <Button type="button" className={control} onClick={onReturn}>
          {m.moderation_workbench_history_return()}
        </Button>
      </div>
    </section>
  );
}
