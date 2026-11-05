import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { loadInventory, type InventoryPage } from './security-inventory';

type Cursor = string | undefined;
type Intent = { cursor: Cursor; direction: 'next' | 'previous' | 'reload' | 'restart' };
type ReadyPage = Extract<InventoryPage<'clients'>, { kind: 'ready' }>;
type Failure = Exclude<InventoryPage<'clients'>['kind'], 'ready'>;
type CopyFeedback = 'idle' | 'pending' | 'copied' | 'failed';
type Observation =
  | { kind: 'loading' | 'retired' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ready'; page: ReadyPage };
type ReviewState = {
  observation: Observation;
  expanded: string | null;
  copy: CopyFeedback;
  previous: boolean;
  accepted: boolean;
};
export type OwnedApplicationReviewOptions = {
  source?: typeof loadInventory;
  preflight?: boolean;
  lifetime?: AbortSignal;
  /** Defaults to the browser clipboard. Injection exercises unavailable/late completion. */
  copyIdentifier?: (identifier: string) => Promise<void>;
};

const emptyState = (): ReviewState => ({
  observation: { kind: 'retired' },
  expanded: null,
  copy: 'idle',
  previous: false,
  accepted: false,
});
const firstPage = (): Intent => ({ cursor: undefined, direction: 'restart' });
const HISTORY_LIMIT = 32;

async function browserCopy(identifier: string) {
  if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(identifier);
}

/** Page-local presentation over the installed bounded read, with no native commands.
 * Only cursor targets survive replacement reads; row DTOs never enter history.
 */
export function useOwnedApplicationReview({
  source = loadInventory,
  lifetime,
  copyIdentifier = browserCopy,
}: OwnedApplicationReviewOptions) {
  const [state, setState] = useState<ReviewState>(emptyState);
  const current = useRef(state);
  const generation = useRef(0);
  const copyGeneration = useRef(0);
  const readLifetime = useRef<AbortController | null>(null);
  const acceptedCursor = useRef<Cursor>(undefined);
  const history = useRef<Cursor[]>([]);
  const intended = useRef<Intent | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  function publish(next: ReviewState) {
    current.current = next;
    setState(next);
  }

  async function read(intent: Intent, focus = true) {
    const controller = readLifetime.current;
    // Close the ref gate before React commits, including same-turn activation.
    if (!controller || controller.signal.aborted || current.current.observation.kind === 'loading') return;
    intended.current = intent;
    const ticket = ++generation.current;
    copyGeneration.current++;
    if (focus) heading.current?.focus();
    publish({ ...current.current, observation: { kind: 'loading' }, expanded: null, copy: 'idle' });
    let result: InventoryPage<'clients'>;
    try {
      result = await source('clients', intent.cursor, controller.signal);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (ticket !== generation.current || controller.signal.aborted) return;
    if (result.kind !== 'ready') {
      publish({ ...current.current, observation: { kind: 'failed', failure: result.kind } });
      return;
    }
    // Commit navigation only when the whole observation is accepted, exactly once.
    if (intent.direction === 'next') history.current = [...history.current, acceptedCursor.current].slice(-HISTORY_LIMIT);
    if (intent.direction === 'previous') history.current = history.current.slice(0, -1);
    if (intent.direction === 'restart') history.current = [];
    acceptedCursor.current = intent.cursor;
    intended.current = null;
    // Copy only the closed public DTO, preserving server row and scope order.
    const page: ReadyPage = {
      kind: 'ready',
      rows: result.rows.map((row) => ({
        client_id: row.client_id,
        display_name: row.display_name,
        disabled: row.disabled,
        scopes: [...row.scopes],
      })),
      next: result.next,
    };
    publish({ observation: { kind: 'ready', page }, expanded: null, copy: 'idle', previous: history.current.length > 0, accepted: true });
  }

  useLayoutEffect(() => {
    const controller = new AbortController();
    readLifetime.current = controller;
    function clear() {
      generation.current++;
      copyGeneration.current++;
      controller.abort();
      intended.current = null;
      acceptedCursor.current = undefined;
      history.current = [];
      publish(emptyState());
    }
    // Parent retirement already commits synchronously. Preserve that boundary
    // when independently mounted with the installed lifetime as well.
    const retire = () => flushSync(clear);
    lifetime?.addEventListener('abort', retire, { once: true });
    if (heading.current?.parentElement?.contains(document.activeElement)) heading.current.focus();
    publish(emptyState());
    if (!lifetime?.aborted) void read(firstPage(), false);
    else controller.abort();
    return () => {
      lifetime?.removeEventListener('abort', retire);
      generation.current++;
      copyGeneration.current++;
      controller.abort();
      intended.current = null;
      acceptedCursor.current = undefined;
      history.current = [];
      current.current = emptyState();
      readLifetime.current = null;
    };
  }, [source, lifetime]);

  function toggle(clientId: string) {
    const value = current.current;
    if (readLifetime.current?.signal.aborted || value.observation.kind !== 'ready') return;
    if (!value.observation.page.rows.some((row) => row.client_id === clientId)) return;
    copyGeneration.current++;
    publish({ ...value, expanded: value.expanded === clientId ? null : clientId, copy: 'idle' });
  }

  async function copy() {
    const value = current.current;
    const controller = readLifetime.current;
    if (!controller || controller.signal.aborted || value.observation.kind !== 'ready' || value.copy === 'pending') return;
    const row = value.observation.page.rows.find((row) => row.client_id === value.expanded);
    if (!row) return;
    const ticket = ++copyGeneration.current;
    const observation = generation.current;
    publish({ ...value, copy: 'pending' });
    let feedback: CopyFeedback = 'copied';
    try {
      await copyIdentifier(row.client_id);
    } catch {
      feedback = 'failed';
    }
    if (controller.signal.aborted || ticket !== copyGeneration.current || observation !== generation.current) return;
    publish({ ...current.current, copy: feedback });
  }

  return {
    ...state,
    heading,
    toggle,
    copy,
    next: () => {
      const value = current.current.observation;
      if (value.kind === 'ready' && value.page.next) void read({ cursor: value.page.next, direction: 'next' });
    },
    previousPage: () => {
      if (history.current.length) void read({ cursor: history.current.at(-1), direction: 'previous' });
    },
    reload: () => void read({ cursor: acceptedCursor.current, direction: 'reload' }),
    retry: () => { if (intended.current) void read(intended.current); },
    restart: () => void read(firstPage()),
  };
}
