import type { Page, Selection } from './data';

/** A replacement-only private observation. No cached success survives a new read or binding. */
export class ErasureReader {
  private page: Page = { status: 'loading' };
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(
    private selection: Selection,
    private read: () => Promise<Page>,
    private isCurrent: () => boolean = () => true,
  ) {}
  snapshot = () => this.page;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private replace(page: Page) {
    this.page = page;
    for (const listener of this.listeners) listener();
  }
  clear() {
    this.generation++;
    this.replace({ status: 'loading' });
  }
  clearIfStale() {
    if (!this.isCurrent()) this.clear();
  }
  async reload() {
    const generation = ++this.generation;
    this.replace({ status: 'loading' });
    if (!this.isCurrent()) return;
    let page: Page;
    try {
      page = await this.read();
    } catch {
      page = { status: 'unavailable' };
    }
    if (generation !== this.generation || !this.isCurrent()) return;
    if (
      page.status === 'ready' &&
      (page.viewerId !== this.selection.viewerId || page.value.accountId !== this.selection.accountId)
    )
      page = { status: 'unavailable' };
    this.replace(page);
  }
}
