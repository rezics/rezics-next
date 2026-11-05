import type {
  MemberAddress,
  MemberPage,
  MemberPageRead,
  MemberRow,
  MemberSelectionAddress,
  MemberSelectionRead,
  RealmMembersSource,
} from './source';
import {
  acceptWindowMove,
  clearStagedMove,
  emptyWindowNavigation,
  sameCoordinate,
  stageWindowMove,
  type StagedWindowMove,
  type WindowDirection,
  type WindowNavigation,
} from './window-navigation';

type DisclosedRow = Extract<MemberRow, { kind: 'disclosed' }>;
type Selection = {
  address: MemberSelectionAddress;
  read: MemberSelectionRead | { kind: 'loading' };
  /** Kept only while the same exact selection is refreshing its explicit status. */
  previous?: Extract<MemberSelectionRead, { kind: 'ready' }>;
};

export type MembersSnapshot = {
  read: MemberPageRead | { kind: 'loading' | 'retired' };
  address: MemberAddress;
  selection: Selection | null;
};

/** One current page, bounded coordinate history, one exact selection, no cached command authority. */
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
  private navigation: WindowNavigation = emptyWindowNavigation();
  private stop: (() => void) | undefined;
  private observation: ReturnType<NonNullable<RealmMembersSource['observe']>> | undefined;

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
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private admitted() {
    if (!this.current() || this.observation?.current() === false) this.retire();
    return this.connected && !this.retired;
  }

  /** Deferred UI effects share the same caller and producer lifetime as reads. */
  isCurrent = () => this.admitted();

  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.connection++;
    this.pageOperation++;
    this.selectedOperation++;
    this.stop?.();
    this.stop = undefined;
    this.observation = undefined;
    this.rows.clear();
    this.pageBusy = false;
    this.navigation = emptyWindowNavigation();
    this.value = {
      read: { kind: 'retired' },
      address: { realmId: this.realmId, cursor: null },
      selection: null,
    };
    this.emit();
  };

  /** Reconnecting for React effect replay starts fresh work; disconnected responses stay obsolete. */
  connect = () => {
    if (this.retired) return () => {};
    this.connected = true;
    this.connection++;
    // Effect replay reconnects this visit, not a new producer lifetime. In particular, a
    // change while unsubscribed must not acquire a fresh observation and revive old data.
    this.observation ??= this.source.observe?.();
    const changed = () => {
      this.admitted();
    };
    const stopCaller = this.watch?.(changed);
    const stopSource = this.observation?.subscribe(changed);
    this.stop = () => {
      stopCaller?.();
      stopSource?.();
    };
    if (this.retired) {
      this.stop();
      this.stop = undefined;
    }
    if (this.admitted()) {
      const address = { realmId: this.realmId, cursor: null };
      const move = stageWindowMove(this.navigation, 'initial', address, null);
      void this.readPage(move);
    }
    return () => {
      this.connected = false;
      this.connection++;
      this.pageOperation++;
      this.selectedOperation++;
      this.pageBusy = false;
      this.stop?.();
      this.stop = undefined;
      this.rows.clear();
      this.navigation = emptyWindowNavigation();
      if (!this.retired)
        this.value = {
          read: { kind: 'loading' },
          address: { realmId: this.realmId, cursor: null },
          selection: null,
        };
      queueMicrotask(() => {
        if (!this.connected) this.retire();
      });
    };
  };

  private index(page: MemberPage): Map<string, DisclosedRow> | null {
    if (
      page.realm.id !== this.realmId ||
      !page.realm.label ||
      !page.authority ||
      !Number.isSafeInteger(this.source.pageBound) ||
      this.source.pageBound < 1 ||
      page.rows.length > this.source.pageBound ||
      (page.next !== null && (typeof page.next !== 'string' || !page.next))
    )
      return null;
    const index = new Map<string, DisclosedRow>();
    for (const row of page.rows) {
      if (row.kind === 'concealed') continue;
      const { identity } = row;
      if (
        !identity.accountId ||
        !identity.reference ||
        !identity.label ||
        !row.membershipInterval ||
        index.has(identity.accountId)
      )
        return null;
      index.set(identity.accountId, row);
    }
    return index;
  }

  private async readPage(move: StagedWindowMove): Promise<boolean> {
    if (!this.admitted() || this.pageBusy || this.navigation.staged !== move) return false;
    const address = move.target;
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
    } finally {
      if (connection === this.connection && operation === this.pageOperation) this.pageBusy = false;
    }
    if (
      !this.admitted() ||
      connection !== this.connection ||
      operation !== this.pageOperation ||
      this.navigation.staged !== move
    )
      return false;
    if (read.kind === 'ready') {
      const index = this.index(read.page);
      if (!index || (move.authority !== null && read.page.authority !== move.authority)) {
        read = { kind: 'unavailable' };
      } else {
        this.rows = index;
        this.navigation = acceptWindowMove(this.navigation, move);
      }
    }
    if (read.kind === 'denied') this.navigation = clearStagedMove(this.navigation, move);
    this.value = {
      read,
      address: read.kind === 'denied' ? { realmId: this.realmId, cursor: null } : address,
      selection: null,
    };
    this.emit();
    return read.kind === 'ready' && sameCoordinate(this.navigation.current, address);
  }

  canPrevious = () => this.navigation.predecessors.length > 0 && this.value.read.kind === 'ready';

  canFirst = () =>
    this.navigation.current !== null && this.navigation.current.cursor !== null && this.value.read.kind === 'ready';

  moreAddress = (): MemberAddress | null => {
    if (!this.admitted() || this.value.read.kind !== 'ready' || this.value.selection) return null;
    const next = this.value.read.page.next;
    return next === null ? null : { realmId: this.realmId, cursor: next };
  };

  previousAddress = (): MemberAddress | null => {
    if (!this.admitted() || !this.canPrevious() || this.value.selection) return null;
    return this.navigation.predecessors.at(-1) ?? null;
  };

  firstAddress = (): MemberAddress | null => {
    if (!this.admitted() || !this.canFirst() || this.value.selection) return null;
    return { realmId: this.realmId, cursor: null };
  };

  isAcceptedAddress = (address: MemberAddress) =>
    this.admitted() && this.value.read.kind === 'ready' && sameCoordinate(this.navigation.current, address);

  private beginMove(direction: Exclude<WindowDirection, 'initial'>, target: MemberAddress): StagedWindowMove | null {
    if (!this.admitted() || this.pageBusy || this.value.read.kind !== 'ready' || this.value.selection) return null;
    return stageWindowMove(this.navigation, direction, target, this.value.read.page.authority);
  }

  more = async (): Promise<boolean> => {
    const target = this.moreAddress();
    if (!target) return false;
    const move = this.beginMove('more', target);
    return move ? this.readPage(move) : false;
  };

  previous = async (): Promise<boolean> => {
    const target = this.previousAddress();
    if (!target) return false;
    const move = this.beginMove('previous', target);
    return move ? this.readPage(move) : false;
  };

  first = async (): Promise<boolean> => {
    if (!this.admitted() || this.pageBusy || this.value.read.kind !== 'ready' || this.value.selection) return false;
    const move = this.beginMove('first', { realmId: this.realmId, cursor: null });
    return move ? this.readPage(move) : false;
  };

  retryPage = async () => {
    if (
      this.value.read.kind !== 'failed' &&
      this.value.read.kind !== 'unavailable' &&
      this.value.read.kind !== 'preparing'
    )
      return;
    const move = this.navigation.staged;
    if (!move) return false;
    return this.readPage(move);
  };

  /** Existing callers that explicitly refresh the roster continue to read the cursor-free first page. */
  refresh = this.first;

  select = async (accountId: string) => {
    if (!this.admitted() || this.pageBusy || this.value.read.kind !== 'ready') return;
    const row = this.rows.get(accountId);
    if (!row) return;
    return this.readSelected({
      realmId: this.realmId,
      accountId: row.identity.accountId,
      membershipInterval: row.membershipInterval,
      authority: this.value.read.page.authority,
    });
  };

  /** Inspect one deliberately entered Account ID without inferring a membership interval. */
  inspectAccount = async (accountId: string) => {
    if (!this.admitted() || this.pageBusy || this.value.read.kind !== 'ready') return;
    return this.readSelected({
      realmId: this.realmId,
      accountId,
      authority: this.value.read.page.authority,
    });
  };

  private async readSelected(
    address: MemberSelectionAddress,
    options: { allowEpisodeChange?: boolean } = {},
  ): Promise<MemberSelectionRead | null> {
    if (!this.admitted() || this.value.read.kind !== 'ready') return null;
    const connection = this.connection;
    const operation = ++this.selectedOperation;
    const pageOperation = this.pageOperation;
    const previous = this.value.selection;
    let previousRead: Extract<MemberSelectionRead, { kind: 'ready' }> | undefined;
    if (
      previous &&
      previous.address.realmId === address.realmId &&
      previous.address.accountId === address.accountId &&
      previous.address.authority === address.authority &&
      previous.address.membershipInterval === address.membershipInterval
    ) {
      previousRead = previous.read.kind === 'ready' ? previous.read : previous.previous;
    }
    this.value = {
      ...this.value,
      selection: { address, read: { kind: 'loading' }, ...(previousRead ? { previous: previousRead } : {}) },
    };
    this.emit();
    const read = await this.source.readSelected({ ...address });
    if (
      !this.admitted() ||
      connection !== this.connection ||
      operation !== this.selectedOperation ||
      pageOperation !== this.pageOperation
    )
      return null;
    let currentRead = read;
    if (read.kind === 'denied') {
      this.rows.clear();
      this.value = { read: { kind: 'denied' }, address: { realmId: this.realmId, cursor: null }, selection: null };
    } else if (
      read.kind === 'ready' &&
      (read.authority !== address.authority ||
        read.realmId !== address.realmId ||
        read.identity.accountId !== address.accountId ||
        (address.membershipInterval !== undefined && read.membershipInterval !== address.membershipInterval) ||
        !read.membershipEpisode ||
        (address.membershipInterval !== undefined && read.membershipEpisode !== address.membershipInterval) ||
        (previousRead !== undefined &&
          !options.allowEpisodeChange &&
          read.membershipEpisode !== previousRead.membershipEpisode) ||
        (read.membership === 'current' &&
          (!read.membershipInterval || read.membershipEpisode !== read.membershipInterval)) ||
        (read.membership === 'none' && read.membershipInterval !== null))
    ) {
      // Currentness changes require a replacement page and a fresh deliberate selection.
      this.rows.clear();
      this.value = { ...this.value, read: { kind: 'unavailable' }, selection: null };
      currentRead = { kind: 'unavailable' };
    } else if (read.kind === 'concealed' || read.kind === 'changed') {
      this.rows.clear();
      this.value = { read: { kind: 'unavailable' }, address: this.value.address, selection: { address, read } };
    } else {
      if (read.kind === 'ready' && (!read.identity.label || !read.identity.reference))
        currentRead = { kind: 'unavailable' };
      const retained =
        previousRead && (currentRead.kind === 'failed' || currentRead.kind === 'unavailable')
          ? { previous: previousRead }
          : {};
      this.value = { ...this.value, selection: { address, read: currentRead, ...retained } };
    }
    this.emit();
    return currentRead;
  }

  retrySelected = async () => {
    const selection = this.value.selection;
    if (!selection || (selection.read.kind !== 'failed' && selection.read.kind !== 'unavailable')) return;
    await this.readSelected(selection.address);
  };

  /** Explicit status readback updates the exact selection without advancing the roster cursor. */
  refreshSelected = async () => {
    const selection = this.value.selection;
    if (!selection || selection.read.kind !== 'ready') return null;
    // Explicit accepted-work readback may replace a selected absence with its new current episode.
    return this.readSelected(selection.address, { allowEpisodeChange: true });
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
