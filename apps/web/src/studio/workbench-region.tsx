import { useId, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';

/** Collapsing a region preserves its mounted command, confirmation and form owners. */
export function WorkbenchRegion({
  title,
  children,
  attention = false,
}: {
  title: string;
  children: ReactNode;
  /** An active review or unresolved command must remain visible until its owner settles it. */
  attention?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const open = attention || expanded;
  return (
    <section className="studio-workbench-region" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>
        <Button
          type="button"
          variant="ghost"
          className="studio-region-trigger"
          aria-expanded={open}
          aria-controls={`${id}-content`}
          onClick={() => setExpanded(!open)}
          disabled={attention}
        >
          {title}
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </Button>
      </h2>
      <div id={`${id}-content`} hidden={!open} className="studio-region-content studio-stack">
        {children}
      </div>
    </section>
  );
}
