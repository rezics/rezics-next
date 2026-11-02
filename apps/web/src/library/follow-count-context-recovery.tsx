import { Button } from '@rezics/ui/shadcn/button';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const recoveryLinkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm px-3 py-2 text-primary underline whitespace-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';

export function FollowCountContextRecovery() {
  const destination = `/${getLocale()}/library/follow-counts`;

  return (
    <div className="space-y-4">
      <p role="status">{m.library_follow_counts_invalid_context()}</p>
      <h3 className="text-lg font-semibold">{m.library_follow_count_context_heading()}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_follow_count_context_id_help()}</p>
      <form action={destination} method="get" className="max-w-xl space-y-4">
        <div className="space-y-2">
          <label htmlFor="follow-count-context-type" className="text-sm font-medium">
            {m.library_follow_count_context_type_label()}
          </label>
          <select
            id="follow-count-context-type"
            name="targetType"
            required
            defaultValue=""
            className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            <option value="" disabled>
              {m.library_follow_count_context_select_type()}
            </option>
            <option value="subject">{m.library_follow_count_context_subject()}</option>
            <option value="collection">{m.library_follow_count_context_collection()}</option>
            <option value="space">{m.library_follow_count_context_space()}</option>
          </select>
        </div>
        <div className="space-y-2">
          <label htmlFor="follow-count-context-id" className="text-sm font-medium">
            {m.library_follow_count_context_id_label()}
          </label>
          <input
            id="follow-count-context-id"
            name="targetId"
            type="text"
            required
            maxLength={36}
            pattern={uuidPattern}
            aria-describedby="follow-count-context-id-help"
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          />
          <p id="follow-count-context-id-help" className="text-sm text-muted-foreground">
            {m.library_follow_count_context_id_format()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.library_follow_count_context_submit()}
          </Button>
          <a href={destination} className={recoveryLinkClass}>
            {m.library_follow_count_context_clear()}
          </a>
        </div>
      </form>
    </div>
  );
}
