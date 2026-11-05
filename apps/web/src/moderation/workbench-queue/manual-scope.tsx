import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { workbenchSearch, type WorkbenchSearch } from './scope';

/** A known scope is navigation input. Its exact native queue read supplies authority. */
export function ManualModerationScope({
  search,
  onSearch,
  isCurrent,
}: {
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  isCurrent?: () => boolean;
}) {
  const id = useId();
  const [board, setBoard] = useState('');
  const [queue, setQueue] = useState('reports');
  const current = () => !isCurrent || isCurrent();
  const discovery = {
    directory: true,
    directoryCursor: search.directoryCursor,
    directoryRealm: search.realm,
  };
  const control = 'min-h-11 min-w-11 max-w-full whitespace-normal break-words';
  return (
    <section aria-labelledby={`${id}-heading`} className="min-w-0 space-y-3">
      <h2 id={`${id}-heading`} className="text-xl font-semibold">
        {m.moderation_manual_heading()}
      </h2>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {m.moderation_manual_hint()}
      </p>
      <form
        className="flex min-w-0 flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const boardId = board.trim();
          if (current() && boardId) onSearch(workbenchSearch({ ...discovery, board: boardId, queue }));
        }}
      >
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <label htmlFor={`${id}-board`} className="block text-sm">
            {m.moderation_manual_board()}
          </label>
          <Input
            id={`${id}-board`}
            name="board"
            required
            maxLength={128}
            value={board}
            onChange={(event) => setBoard(event.target.value)}
            aria-describedby={`${id}-hint`}
            className="min-h-11 min-w-0 w-full"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <label htmlFor={`${id}-queue`} className="block text-sm">
            {m.moderation_workbench_heading()}
          </label>
          <NativeSelect
            id={`${id}-queue`}
            name="queue"
            value={queue}
            onChange={(event) => setQueue(event.target.value)}
            className="w-full min-w-0 [&_select]:min-h-11"
          >
            <NativeSelectOption value="reports">{m.moderation_workbench_queue_reports()}</NativeSelectOption>
            <NativeSelectOption value="appeals">{m.moderation_workbench_queue_appeals()}</NativeSelectOption>
            <NativeSelectOption value="resolved">{m.moderation_workbench_queue_resolved()}</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button type="submit" className={control}>
          {m.moderation_manual_open()}
        </Button>
      </form>
      <Button
        type="button"
        variant="outline"
        className={control}
        onClick={() => {
          if (current()) onSearch(workbenchSearch({ ...discovery, scope: 'catalogue', queue: 'reports' }));
        }}
      >
        {m.moderation_manual_catalogue()}
      </Button>
    </section>
  );
}
