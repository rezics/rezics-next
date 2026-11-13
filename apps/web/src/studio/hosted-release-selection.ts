import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedOutlineWindowNative, HostedRevision } from './hosted-contract';
import { HostedOutlineWindow, type HostedOutlineWindowState } from './hosted-outline-window';

export type ReleaseSelectionState = Readonly<{
  outline: HostedOutlineWindowState;
  /** Only the current page's unsent choices. Never a projection of all native input. */
  occurrenceIds: readonly string[];
}>;

/** One exact outline page; the preparation visit owns command replay and all native input. */
export class HostedReleaseSelectionWindow {
  private readonly window: HostedOutlineWindow;
  private readonly unsubscribe: () => void;
  private state: ReleaseSelectionState;

  constructor(
    native: HostedOutlineWindowNative,
    source: HistoricalReaderSource,
    accountId: string,
    revision: HostedRevision,
    current: () => boolean,
    private readonly changed: (state: ReleaseSelectionState) => void,
  ) {
    this.window = new HostedOutlineWindow(native, source, accountId, revision, current);
    this.state = { outline: this.window.snapshot(), occurrenceIds: [] };
    this.unsubscribe = this.window.subscribe(() => {
      this.state = { outline: this.window.snapshot(), occurrenceIds: [] };
      this.changed(this.state);
    });
  }

  snapshot = () => this.state;
  toggle = (occurrenceId: string) => {
    const { outline, occurrenceIds } = this.state;
    if (
      outline.kind !== 'ready' ||
      !outline.page.items.some((item) => item.occurrenceId === occurrenceId && item.availability === 'available')
    )
      return;
    this.state = {
      outline,
      occurrenceIds: occurrenceIds.includes(occurrenceId)
        ? occurrenceIds.filter((id) => id !== occurrenceId)
        : [...occurrenceIds, occurrenceId],
    };
    this.changed(this.state);
  };
  acknowledged = () => {
    this.state = { ...this.state, occurrenceIds: [] };
    this.changed(this.state);
  };
  load = () => this.window.load();
  next = () => this.window.next();
  first = () => this.window.load(null);
  dispose = () => {
    this.unsubscribe();
    this.window.dispose();
  };
}
