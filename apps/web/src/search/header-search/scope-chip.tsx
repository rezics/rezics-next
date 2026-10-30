import { X } from 'lucide-react';
import { m } from '../../paraglide/messages.js';
import type { SearchScope } from './types';

export function ScopeChip({ scope, onRemove }: { scope: SearchScope; onRemove: () => void }) {
  return (
    <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">
      {scope.image ? (
        <img src={scope.image} alt="" className="size-5 shrink-0 rounded-full object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 font-semibold"
        >
          {scope.name.slice(0, 1)}
        </span>
      )}
      <span className="truncate">{scope.name}</span>
      <button
        type="button"
        aria-label={m.header_search_remove_scope({ scope: scope.name })}
        className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onRemove}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}
