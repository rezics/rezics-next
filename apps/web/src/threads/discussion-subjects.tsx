import { EntityPicker, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Label } from '@rezics/ui/shadcn/label';
import { useId, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { searchContentSubjects } from './content-subject-search';
import { useThreadCreationVisit } from './thread-creation-lifetime';

export function DiscussionSubjects({
  ...props
}: {
  value: readonly EntityPickerSubject[];
  onValueChange: (items: EntityPickerSubject[]) => void;
  searchScope: string;
  disabled?: boolean;
}) {
  return (
    <DiscussionSubjectsVisit
      key={props.searchScope}
      value={props.value}
      onValueChange={props.onValueChange}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
    />
  );
}

function DiscussionSubjectsVisit({
  value,
  onValueChange,
  disabled = false,
}: {
  value: readonly EntityPickerSubject[];
  onValueChange: (items: EntityPickerSubject[]) => void;
  disabled?: boolean;
}) {
  const countId = useId();
  const [overLimit, setOverLimit] = useState(false);
  const visit = useThreadCreationVisit();
  const limit = 128;

  function choose(items: EntityPickerSubject[]) {
    if (disabled || !visit.isEditable()) return;
    if (items.length > limit) {
      setOverLimit(true);
      return;
    }
    setOverLimit(false);
    onValueChange(items);
  }

  return (
    <section
      className="space-y-3 rounded-xl border border-border/70 bg-card p-5"
      aria-label={m.thread_discussion_subjects()}
      aria-describedby={countId}
    >
      <Label>{m.thread_discussion_subjects()}</Label>
      <p id={countId} role="status" className="text-sm text-muted-foreground">
        {m.thread_discussion_subject_count({ count: value.length, limit })}
      </p>
      <EntityPicker
        multiple
        label={m.thread_discussion_subjects()}
        search={searchContentSubjects}
        src={coverSrc}
        value={value}
        disabled={disabled}
        onValueChange={choose}
      />
      {overLimit ? (
        <p role="alert" className="text-sm text-destructive">
          {m.thread_discussion_subject_limit({ limit })}
        </p>
      ) : null}
    </section>
  );
}
