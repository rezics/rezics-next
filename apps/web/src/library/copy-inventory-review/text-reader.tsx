import { useId, useState } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { Button } from '@rezics/ui/shadcn/button';

export const dateText = (value: string) =>
  value
    ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${value}T12:00:00Z`),
      )
    : '';

export function CopyTextReader({
  label,
  value,
  expandLabel,
  collapseLabel,
}: {
  label: string;
  value: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="min-w-0 max-w-full text-sm text-muted-foreground">
      <p id={`${id}-label`} className="font-medium">
        {label}
      </p>
      <p
        id={id}
        className={`min-w-0 max-w-full whitespace-break-spaces [overflow-wrap:anywhere] ${expanded ? '' : 'line-clamp-2'}`}
      >
        {value}
      </p>
      <Button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        variant="outline" className='h-auto min-h-7 max-w-full text-left whitespace-normal [overflow-wrap:anywhere]'
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? collapseLabel : expandLabel}
      </Button>
    </div>
  );
}
