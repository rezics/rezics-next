import { safeReturnTo, type DiaryAddress } from './address';

export const PRIVATE_DIARY_PREDECESSOR_LIMIT = 8;

type Movement = 'next' | 'previous' | 'first';
type PendingMovement = Movement | 'period' | 'external';

type StagedAddress = {
  address: DiaryAddress;
  key: string;
  fromKey: string | null;
  movement: PendingMovement;
  focus: boolean;
  previousIndex: number;
};

export type DiaryWindowObservation = {
  source: string;
  address: DiaryAddress;
  admitted: boolean;
  continuation: string | null | undefined;
  load: object;
  retire?: boolean;
};

export type DiaryWindowChange = {
  changed: boolean;
  focus: boolean;
  cancelContinuation?: string;
};

function windowAddress(address: DiaryAddress): DiaryAddress {
  return {
    ...(address.cursor === undefined ? {} : { cursor: address.cursor }),
    ...(address.year === undefined ? {} : { year: address.year }),
    ...(address.month === undefined ? {} : { month: address.month }),
    ...(address.snapshot === undefined ? {} : { snapshot: address.snapshot }),
    ...(address.returnTo === undefined ? {} : { returnTo: safeReturnTo(address.returnTo) }),
  };
}

function addressKey(address: DiaryAddress): string {
  const value = windowAddress(address);
  return JSON.stringify([value.cursor, value.year, value.month, value.snapshot, value.returnTo]);
}

function periodKey(address: DiaryAddress): string {
  const value = windowAddress(address);
  return JSON.stringify([value.year, value.month, value.snapshot, value.returnTo]);
}

function sameAddress(a: DiaryAddress, b: DiaryAddress): boolean {
  return addressKey(a) === addressKey(b);
}

/** Keeps only admitted route coordinates; rows remain in the current native page. */
export class PrivateDiaryWindowNavigation {
  source: string;
  current: DiaryAddress | null = null;
  continuation: string | null = null;
  predecessors: DiaryAddress[] = [];
  staged: StagedAddress | null = null;
  private currentKey: string | null = null;
  private currentPeriod: string | null = null;
  private currentLoad: object | null = null;

  constructor(source: string) {
    this.source = source;
  }

  resetSource(source: string) {
    this.source = source;
    this.retire();
  }

  retire() {
    this.current = null;
    this.continuation = null;
    this.predecessors = [];
    this.staged = null;
    this.currentKey = null;
    this.currentPeriod = null;
    this.currentLoad = null;
  }

  canUse(address: DiaryAddress) {
    return this.staged === null && this.currentKey === addressKey(address);
  }

  previousAddress(): DiaryAddress | null {
    return this.predecessors.at(-1) ?? null;
  }

  canStartFirst(address: DiaryAddress) {
    return this.canUse(address) && (address.cursor !== undefined || this.predecessors.length > 0);
  }

  stage(movement: Movement, target: DiaryAddress, focus: boolean): boolean {
    if (!this.canUse(this.current ?? {}) || this.staged) return false;
    const address = windowAddress(target);
    const current = this.current;
    const action = movement === 'previous' && address.cursor === undefined ? 'first' : movement;
    this.staged = {
      address,
      key: addressKey(address),
      fromKey: current ? addressKey(current) : null,
      movement: action,
      focus,
      previousIndex: this.predecessors.findIndex((item) => sameAddress(item, address)),
    };
    return true;
  }

  observe({
    source,
    address,
    admitted,
    continuation,
    load,
    retire = false,
  }: DiaryWindowObservation): DiaryWindowChange {
    if (source !== this.source) this.resetSource(source);
    if (retire) {
      const changed = this.current !== null || this.staged !== null || this.predecessors.length > 0;
      this.retire();
      return { changed, focus: false };
    }

    const key = addressKey(address);
    const normalized = windowAddress(address);
    if (this.staged && key !== this.staged.key && key !== this.staged.fromKey) this.staged = null;

    if (!this.current) {
      if (!admitted) return { changed: false, focus: false };
      this.current = address;
      this.currentKey = key;
      this.currentPeriod = periodKey(address);
      this.continuation = continuation ?? null;
      this.currentLoad = load;
      return { changed: true, focus: false };
    }

    if (this.staged && key === this.staged.fromKey) return { changed: false, focus: false };
    if (this.staged && key === this.staged.key) {
      if (!admitted) return { changed: false, focus: false };
      return this.commit(normalized, key, continuation ?? null, load);
    }

    if (key === this.currentKey) {
      if (!admitted) return { changed: false, focus: false };
      if (load !== this.currentLoad) {
        this.current = address;
        this.continuation = continuation ?? null;
        this.predecessors = [];
        this.currentLoad = load;
        return { changed: true, focus: false };
      }
      this.current = address;
      return { changed: false, focus: false };
    }

    const previousIndex = this.predecessors.findIndex((item) => sameAddress(item, address));
    const movement: PendingMovement =
      periodKey(address) !== this.currentPeriod
        ? 'period'
        : previousIndex >= 0
          ? normalized.cursor === undefined
            ? 'first'
            : 'previous'
          : 'external';
    this.staged = {
      address: normalized,
      key,
      fromKey: this.currentKey,
      movement,
      focus: false,
      previousIndex,
    };
    if (!admitted) return { changed: true, focus: false };
    return this.commit(normalized, key, continuation ?? null, load);
  }

  private commit(address: DiaryAddress, key: string, continuation: string | null, load: object): DiaryWindowChange {
    const pending = this.staged!;
    const previousIndex = pending.previousIndex;
    const oldContinuation = this.continuation;
    if (pending.movement === 'next' && this.current) {
      this.predecessors.push(windowAddress(this.current));
      if (this.predecessors.length > PRIVATE_DIARY_PREDECESSOR_LIMIT) this.predecessors.shift();
    } else if (pending.movement === 'previous' && previousIndex >= 0) {
      this.predecessors = this.predecessors.slice(0, previousIndex);
    } else if (
      pending.movement === 'previous' ||
      pending.movement === 'first' ||
      pending.movement === 'period' ||
      pending.movement === 'external'
    ) {
      this.predecessors = [];
    }

    this.current = address;
    this.currentKey = key;
    this.currentPeriod = periodKey(address);
    this.continuation = continuation;
    this.currentLoad = load;
    this.staged = null;
    const cancelContinuation =
      pending.movement !== 'next' &&
      pending.movement !== 'previous' &&
      oldContinuation &&
      oldContinuation !== continuation
        ? oldContinuation
        : undefined;
    return {
      changed: true,
      focus: pending.focus,
      ...(cancelContinuation ? { cancelContinuation } : {}),
    };
  }
}

export function diaryWindowKey(address: DiaryAddress) {
  return addressKey(address);
}
