import type {
  MemberAddress,
  MemberPage,
  MemberPageRead,
  MemberRow,
  MemberSelectionAddress,
  MemberSelectionRead,
  RealmMembersSource,
} from './source';

type DisclosedRow = Extract<MemberRow, { kind: 'disclosed' }>;
type Selection = {
  address: MemberSelectionAddress;
  read: MemberSelectionRead | { kind: 'loading' };
};

export type MembersSnapshot = {
  read: MemberPageRead | { kind: 'loading' | 'retired' };
  address: MemberAddress;
  selection: Selection | null;
};

/** One page, one exact selection, no cached identity or command authority. */
export class RealmMembersVisit {
  private value: MembersSnapshot;
  private rows = new Map<string, DisclosedRow>();
  private listeners = new Set<() => void>();
  private connection = 0;
  private connected = false;
  private retired = false;
  private pageOperation = 0;
  private selectedOperation = 0;
  private pageBusy = false;
  private stop: (() => void) | undefined;

  constructor(
    private readonly realmId: string,
    private readonly source: RealmMembersSource,
    private readonly current: () => boolean = () => true,
    private readonly watch?: (listener: () => void) => () => void,
  ) {
    this.value = {
      read: { kind: 'loading' },
      address: { realmId, cursor: null },
      selection: null,
    };
  }

  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private admitted() {
    if (!this.current()) this.retire();
    return this.connected && !this.retired;
  }

  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.connection++;
    this.pageOperation++;
    this.selectedOperation++;
    this.rows.clear();
    this.value = {
      read: { kind: 'retired' },
      address: { realmId: this.realmId, cursor: null },
      selection: null,
    };
    this.emit();
  };

  /** Reconnecting for React effect replay starts fresh work; disconnected responses stay obsolete. */
  connect = () => {
    this.connected = true;
    this.connection++;
    this.stop = this.watch?.(() => { if (!this.current()) this.retire(); });
    if (this.admitted()) void this.readPage(this.value.address);
    return () => {
      this.connected = false;
      this.connection++;
      this.pageOperation++;
      this.selectedOperation++;
      this.pageBusy = false;
      this.stop?.();
      this.stop = undefined;
      this.rows.clear();
      this.value = {
        read: { kind: 'loading' },
        address: { realmId: this.realmId, cursor: null },
        selection: null,
      };
      queueMicrotask(() => { if (!this.connected) this.retire(); });
    };
  };

  private index(page: MemberPage): Map<string, DisclosedRow> | null {
    if (
      page.realm.id !== this.realmId || !page.realm.label || !page.authority ||
      !Number.isSafeInteger(this.source.pageBound) || this.source.pageBound < 1 ||
      page.rows.length > this.source.pageBound ||
      (page.next !== null && (typeof page.next !== 'string' || !page.next))
    ) return null;
    const index = new Map<string, DisclosedRow>();
    for (const row of page.rows) {
      if (row.kind === 'concealed') continue;
      const { identity } = row;
      if (!identity.accountId || !identity.reference || !identity.label || !row.episode ||
          index.has(identity.accountId)) return null;
      index.set(identity.accountId, row);
    }
    return index;
  }

  private async readPage(address: MemberAddress) {
    if (!this.admitted() || this.pageBusy) return;
    const operation = ++this.pageOperation;
    const connection = this.connection;
    this.pageBusy = true;
    this.selectedOperation++;
    this.rows.clear();
    // Retire the old observation before calling the next address, including on failed continuation.
    this.value = { read: { kind: 'loading' }, address, selection: null };
    this.emit();
    let read: MemberPageRead;
    try {
      read = await this.source.readPage({ ...address });
    } catch {
      read = { kind: 'failed' };
    }
    if (!this.admitted() || connection !== this.connection || operation !== this.pageOperation) return;
    this.pageBusy = false;
    if (read.kind === 'ready') {
      const index = this.index(read.page);
      if (index) this.rows = index;
      else read = { kind: 'unavailable' };
    }
    this.value = { read, address, selection: null };
    this.emit();
  }

  more = async () => {
    if (!this.admitted() || this.value.read.kind !== 'ready') return;
    const next = this.value.read.page.next;
    if (next !== null) await this.readPage({ realmId: this.realmId, cursor: next });
  };

  retryPage = async () => {
    if (this.value.read.kind !== 'failed' && this.value.read.kind !== 'unavailable' &&
        this.value.read.kind !== 'preparing') return;
    await this.readPage(this.value.address);
  };

  refresh = async () => {
    await this.readPage({ realmId: this.realmId, cursor: null });
  };

  select = async (accountId: string) => {
    if (!this.admitted() || this.pageBusy || this.value.read.kind !== 'ready') return;
    const row = this.rows.get(accountId);
    if (!row) return;
    await this.readSelected({
      realmId: this.realmId,
      accountId: row.identity.accountId,
      episode: row.episode,
      authority: this.value.read.page.authority,
    });
  };

  private async readSelected(address: MemberSelectionAddress) {
    if (!this.admitted() || this.value.read.kind !== 'ready') return;
    const connection = this.connection;
    const operation = ++this.selectedOperation;
    const pageOperation = this.pageOperation;
    this.value = { ...this.value, selection: { address, read: { kind: 'loading' } } };
    this.emit();
    let read: MemberSelectionRead;
    try {
      read = await this.source.readSelected({ ...address });
    } catch {
      read = { kind: 'failed' };
    }
    if (!this.admitted() || connection !== this.connection || operation !== this.selectedOperation ||
        pageOperation !== this.pageOperation) return;
    if (read.kind === 'denied') {
      this.rows.clear();
      this.value = { ...this.value, read: { kind: 'denied' }, selection: null };
    } else if (read.kind === 'ready' &&
      (read.authority !== address.authority || read.realmId !== address.realmId ||
       read.identity.accountId !== address.accountId || read.episode !== address.episode)) {
      // Currentness changes require a replacement page and a fresh deliberate selection.
      this.rows.clear();
      this.value = { ...this.value, read: { kind: 'unavailable' }, selection: null };
    } else if (read.kind === 'concealed' || read.kind === 'changed') {
      this.rows.clear();
      this.value = { read: { kind: 'unavailable' }, address: this.value.address, selection: { address, read } };
    } else {
      if (read.kind === 'ready' && (!read.identity.label || !read.identity.reference))
        read = { kind: 'unavailable' };
      this.value = { ...this.value, selection: { address, read } };
    }
    this.emit();
  }

  retrySelected = async () => {
    const selection = this.value.selection;
    if (!selection || (selection.read.kind !== 'failed' && selection.read.kind !== 'unavailable')) return;
    await this.readSelected(selection.address);
  };

  closeSelection = () => {
    if (!this.admitted()) return;
    this.selectedOperation++;
    this.value = { ...this.value, selection: null };
    this.emit();
  };

  /** Focus restoration must use a still-disclosed row in this exact page and connection. */
  hasRow = (accountId: string) => this.admitted() && this.rows.has(accountId);
}
