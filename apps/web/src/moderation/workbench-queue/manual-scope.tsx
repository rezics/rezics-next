import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
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
        <Field className="min-w-0 flex-1 basis-48 space-y-1">
          <FieldLabel htmlFor={`${id}-queue`} className="block text-sm">
            {m.moderation_workbench_heading()}
          </FieldLabel>
          <Select
            items={[
              { value: 'reports', label: m.moderation_workbench_queue_reports() },
              { value: 'appeals', label: m.moderation_workbench_queue_appeals() },
              { value: 'resolved', label: m.moderation_workbench_queue_resolved() },
            ]}
            name="queue"
            value={queue}
            onValueChange={(value) => setQueue(value!)}
          >
            <SelectTrigger id={`${id}-queue`} className="w-full min-w-0 min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="reports">{m.moderation_workbench_queue_reports()}</SelectItem>
                <SelectItem value="appeals">{m.moderation_workbench_queue_appeals()}</SelectItem>
                <SelectItem value="resolved">{m.moderation_workbench_queue_resolved()}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
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
