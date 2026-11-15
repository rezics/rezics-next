import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { cn } from '@rezics/ui/utils';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const recoveryLinkClass = cn(
  buttonVariants({ variant: 'link' }),
  'h-auto min-h-7 max-w-full whitespace-normal px-0',
);
const wrapAction = 'h-auto min-h-7 max-w-full whitespace-normal';

export function FollowCountContextRecovery() {
  const destination = `/${getLocale()}/library/follow-counts`;

  const contextTypeOptions = [
    { value: null, label: m.library_follow_count_context_select_type(), disabled: true },
    { value: 'subject', label: m.library_follow_count_context_subject() },
    { value: 'collection', label: m.library_follow_count_context_collection() },
    { value: 'space', label: m.library_follow_count_context_space() },
  ];
  return (
    <div className="space-y-4">
      <p role="status">{m.library_follow_counts_invalid_context()}</p>
      <h3 className="text-lg font-semibold">{m.library_follow_count_context_heading()}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_follow_count_context_id_help()}</p>
      <form action={destination} method="get" className="max-w-xl space-y-4">
        <div className="space-y-2">
          <Field className="gap-2">
            <FieldLabel id={`${'follow-count-context-type'}-label`} htmlFor={'follow-count-context-type'}>
              {m.library_follow_count_context_type_label()}
            </FieldLabel>
            <Select<string, false> items={contextTypeOptions} name="targetType" required defaultValue={null}>
              <SelectTrigger
                id="follow-count-context-type"
                aria-labelledby={`${'follow-count-context-type'}-label`}
                className="w-full max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {contextTypeOptions.map(({ value, label, ...itemProps }) => (
                    <SelectItem key={value ?? ''} value={value} {...itemProps}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="space-y-2">
          <label htmlFor="follow-count-context-id" className="text-sm font-medium">
            {m.library_follow_count_context_id_label()}
          </label>
          <Input
            id="follow-count-context-id"
            name="targetId"
            type="text"
            required
            maxLength={36}
            pattern={uuidPattern}
            aria-describedby="follow-count-context-id-help"
          />
          <p id="follow-count-context-id-help" className="text-sm text-muted-foreground">
            {m.library_follow_count_context_id_help()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className={wrapAction}>
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
