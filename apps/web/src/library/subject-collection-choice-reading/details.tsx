import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import type { ChooserCollectionRow } from '../subject-collection-journey/model';

const buttonClass = `${buttonVariants({ variant: 'outline' })} h-auto min-h-[44px] min-w-0 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]`;

/** Read the supplied destination without hydrating or deriving any additional facts. */
export function ReceivedCollectionDetails({
  row,
  canChoose,
  onChoose,
  onClose,
}: {
  row: ChooserCollectionRow;
  canChoose: boolean;
  onChoose: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [row]);

  const visibility =
    row.visibility === 'public'
      ? m.library_destination_public()
      : row.visibility === 'unlisted'
        ? m.library_destination_unlisted()
        : row.visibility === 'private'
          ? m.library_destination_private()
          : m.library_destination_visibility_unknown();
  const visibilityMeaning =
    row.visibility === 'public'
      ? m.library_destination_public_meaning()
      : row.visibility === 'unlisted'
        ? m.library_destination_unlisted_meaning()
        : row.visibility === 'private'
          ? m.library_destination_private_meaning()
          : null;

  return (
    <section
      data-collection-inspection
      aria-labelledby={titleId}
      className="mt-3 min-w-0 space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm [overflow-wrap:anywhere]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{m.library_destination_heading()}</p>
          <h4 id={titleId} ref={heading} tabIndex={-1} className="font-medium">
            {row.title}
          </h4>
        </div>
        <button type="button" className={buttonClass} onClick={onClose}>
          {m.library_destination_close()}
        </button>
      </div>
      <dl className="min-w-0 space-y-3">
        <div>
          <dt className="text-muted-foreground">{m.library_destination_curator()}</dt>
          <dd className="min-w-0">
            {row.curator?.displayName || row.curator?.handle ? (
              <>
                {row.curator.displayName ? <span className="block">{row.curator.displayName}</span> : null}
                {row.curator.handle ? <span className="block">@{row.curator.handle}</span> : null}
              </>
            ) : (
              m.library_destination_curator_unavailable()
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.library_destination_visibility()}</dt>
          <dd>
            <span className="block font-medium">{visibility}</span>
            {visibilityMeaning ? <span className="block">{visibilityMeaning}</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{m.library_destination_members()}</dt>
          <dd>
            <span className="block font-medium">{m.library_destination_member_count({ count: row.memberCount })}</span>
            <span className="block">{m.library_destination_member_meaning()}</span>
          </dd>
        </div>
      </dl>
      <p className="text-muted-foreground">{m.library_destination_add_meaning()}</p>
      <button type="button" className={buttonClass} disabled={!canChoose} onClick={onChoose}>
        {m.library_destination_choose()}
      </button>
    </section>
  );
}
