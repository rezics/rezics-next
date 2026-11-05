import type { CreatorStatementData, CreatorStatementsAddress, CreatorStatementsData } from './creator-statements';

export const CREATOR_STATEMENT_PREDECESSOR_LIMIT = 8;
type Position = string | null;
type Path = { current: Position; previous: Position[] };
type LinePath = Path & { statementId: string };
type Page = CreatorStatementsData | CreatorStatementData | { kind: 'preparing' };
type Movement =
  | 'list-next'
  | 'list-previous'
  | 'list-restart'
  | 'list-restore'
  | 'line-next'
  | 'line-previous'
  | 'line-restart'
  | 'line-restore'
  | 'open'
  | 'return';
type Pending = {
  movement: Movement;
  source: CreatorStatementsAddress;
  target: CreatorStatementsAddress;
  focus: boolean;
};
type Candidate = { targetId: string; cancel(): void };

function sameStatementsAddress(a: CreatorStatementsAddress, b: CreatorStatementsAddress) {
  return (
    a.kind === b.kind &&
    a.locale === b.locale &&
    a.cursor === b.cursor &&
    (a.kind === 'list' || (b.kind === 'detail' && a.id === b.id && a.from === b.from))
  );
}

export type StatementWindowControls = {
  previous?: Position;
  restart: boolean;
  next?: string;
};

function cursor(address: CreatorStatementsAddress): Position {
  return address.cursor;
}

function pageReady(page: Page, address: CreatorStatementsAddress) {
  if (address.kind === 'list') return page.kind === 'ready' && 'payoutStatements' in page;
  return page.kind === 'ready' && 'statement' in page && page.statement.id === address.id;
}

function linesReady(page: Page, address: CreatorStatementsAddress) {
  return (
    address.kind === 'detail' &&
    page.kind === 'ready' &&
    'statement' in page &&
    page.statement.id === address.id &&
    page.lines.kind === 'ready'
  );
}

function encodeAddress(address: CreatorStatementsAddress) {
  return JSON.stringify(address);
}

function parseAddress(href: string, locale: string): CreatorStatementsAddress | null {
  const url = new URL(href, window.location.href);
  const search = url.searchParams;
  const cursor = search.get('cursor') || null;
  const from = search.get('from') || null;
  const root = `/${locale}/creator/statements`;
  if (url.pathname === root || url.pathname === '/creator/statements') return { kind: 'list', locale, cursor };
  const prefix = `${root}/`;
  const plainPrefix = '/creator/statements/';
  const id = url.pathname.startsWith(prefix)
    ? decodeURIComponent(url.pathname.slice(prefix.length))
    : url.pathname.startsWith(plainPrefix)
      ? decodeURIComponent(url.pathname.slice(plainPrefix.length))
      : null;
  return id ? { kind: 'detail', locale, id, cursor, from } : null;
}

function previous(
  path: Path | undefined,
  address: CreatorStatementsAddress,
  pending: Pending | null,
): Position | undefined {
  if (pending && sameStatementsAddress(pending.target, address)) {
    if (pending.movement === 'list-next' && address.kind === 'list') return pending.source.cursor;
    if (pending.movement === 'line-next' && address.kind === 'detail') return pending.source.cursor;
  }
  const value = path?.previous.at(-1);
  return value !== undefined && value !== address.cursor ? value : undefined;
}

/** Opaque route coordinates shared only by the active QueryClient and current identity. */
export class CreatorStatementWindows {
  private version = 0;
  private listeners = new Set<() => void>();
  private users = 0;
  private list: Path | undefined;
  private lines: LinePath | undefined;
  private route: CreatorStatementsAddress | null = null;
  private source: string | null = null;
  private pending: Pending | null = null;
  private candidate: Candidate | null = null;

  constructor(readonly identity: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  private publish() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  mount() {
    this.users++;
    return () => {
      this.users--;
      queueMicrotask(() => {
        if (this.users === 0 && !this.pending) this.reset();
      });
    };
  }

  reset() {
    this.cancelFocus();
    this.list = undefined;
    this.lines = undefined;
    this.route = null;
    this.source = null;
    this.pending = null;
    this.publish();
  }

  private initialize(address: CreatorStatementsAddress, source: string) {
    this.cancelFocus();
    this.pending = null;
    this.route = address;
    this.source = source;
    this.list = {
      current: address.kind === 'list' ? address.cursor : address.from,
      previous: [],
    };
    this.lines =
      address.kind === 'detail' ? { statementId: address.id, current: address.cursor, previous: [] } : undefined;
    this.publish();
  }

  private push(path: Path, current: Position, next: Position) {
    const previous = [...path.previous, current];
    if (previous.length > CREATOR_STATEMENT_PREDECESSOR_LIMIT) previous.shift();
    return { current: next, previous };
  }

  private commit(pending: Pending, source: string) {
    const { movement, target } = pending;
    switch (movement) {
      case 'list-next':
        if (target.kind === 'list' && this.list) this.list = this.push(this.list, this.list.current, target.cursor);
        break;
      case 'list-previous':
        if (target.kind === 'list' && this.list) {
          this.list = { current: target.cursor, previous: this.list.previous.slice(0, -1) };
        }
        break;
      case 'list-restart':
        if (target.kind === 'list') this.list = { current: null, previous: [] };
        break;
      case 'list-restore':
        break;
      case 'line-next':
        if (target.kind === 'detail' && this.lines?.statementId === target.id) {
          this.lines = {
            ...this.push(this.lines, this.lines.current, target.cursor),
            statementId: this.lines.statementId,
          };
        }
        break;
      case 'line-previous':
        if (target.kind === 'detail' && this.lines?.statementId === target.id) {
          this.lines = { ...this.lines, current: target.cursor, previous: this.lines.previous.slice(0, -1) };
        }
        break;
      case 'line-restart':
        if (target.kind === 'detail') this.lines = { statementId: target.id, current: null, previous: [] };
        break;
      case 'line-restore':
        break;
      case 'open':
        if (target.kind === 'detail') {
          if (this.list?.current !== target.from) this.list = { current: target.from, previous: [] };
          this.lines = { statementId: target.id, current: target.cursor, previous: [] };
        }
        break;
      case 'return':
        if (target.kind === 'list') {
          if (this.list?.current !== target.cursor) this.list = { current: target.cursor, previous: [] };
          this.lines = undefined;
        }
        break;
    }
    this.route = target;
    this.source = source;
    this.pending = null;
    this.publish();
  }

  admit(address: CreatorStatementsAddress, source: string, page: Page, isCurrent: boolean): string | null {
    if (!isCurrent) {
      this.reset();
      return null;
    }
    const pending = this.pending;
    if (pending && sameStatementsAddress(pending.target, address)) {
      this.route = address;
      this.source = source;
      if (page.kind === 'denied') {
        if (address.kind === 'list') {
          this.list = undefined;
          this.lines = undefined;
        } else this.lines = undefined;
        this.pending = null;
        this.cancelFocus();
        this.publish();
        return null;
      }
      const ready =
        pending.movement === 'open'
          ? pageReady(page, address)
          : pending.movement === 'return' || pending.movement.startsWith('list-')
            ? pageReady(page, address)
            : linesReady(page, address);
      if (!ready) {
        this.cancelFocus();
        this.publish();
        return null;
      }
      const focus = pending.focus
        ? pending.movement.startsWith('list-')
          ? 'statements-heading'
          : pending.movement.startsWith('line-')
            ? 'statement-lines'
            : null
        : null;
      this.commit(pending, source);
      return focus;
    }
    if (this.route && sameStatementsAddress(this.route, address) && this.source === source) return null;
    this.initialize(address, source);
    if (page.kind === 'denied') {
      if (address.kind === 'list') {
        this.list = undefined;
        this.lines = undefined;
      } else this.lines = undefined;
      this.publish();
    }
    return null;
  }

  failed(address: CreatorStatementsAddress, source: string, isCurrent: boolean) {
    if (!isCurrent) {
      this.reset();
      return;
    }
    if (this.pending && sameStatementsAddress(this.pending.target, address)) {
      this.route = address;
      this.source = source;
      this.cancelFocus();
      this.publish();
      return;
    }
    if (!this.route || !sameStatementsAddress(this.route, address) || this.source !== source) {
      this.initialize(address, source);
      this.list = undefined;
      this.lines = undefined;
      this.publish();
    }
  }

  controls(address: CreatorStatementsAddress, page: Page): StatementWindowControls {
    if (address.kind === 'list') {
      const path = this.list?.current === address.cursor ? this.list : undefined;
      const prior = previous(path, address, this.pending);
      return {
        ...(prior !== undefined ? { previous: prior } : {}),
        restart: address.cursor !== null || !!path?.previous.length,
        ...(page.kind === 'ready' && 'payoutStatements' in page && page.next ? { next: page.next } : {}),
      };
    }
    const path =
      this.lines?.statementId === address.id && this.lines.current === address.cursor ? this.lines : undefined;
    const prior = previous(path, address, this.pending);
    return {
      ...(prior !== undefined ? { previous: prior } : {}),
      restart: address.cursor !== null || !!path?.previous.length,
      ...(page.kind === 'ready' &&
      'statement' in page &&
      page.statement.id === address.id &&
      page.lines.kind === 'ready' &&
      page.lines.next
        ? { next: page.lines.next }
        : {}),
    };
  }

  markKeyboardActivation(href: string, locale: string, keyboard: boolean) {
    this.cancelFocus();
    if (!keyboard) return;
    const target = parseAddress(href, locale);
    if (!target) return;
    const targetId = encodeAddress(target);
    const anchor = document.activeElement;
    const cancel = () => this.cancelFocus();
    const onFocus = (event: FocusEvent) => {
      const node = event.target;
      if (node === anchor || node === document.body) return;
      if (node instanceof Element && node.closest('[role="alertdialog"]')) return;
      cancel();
    };
    document.addEventListener('focusin', onFocus);
    this.candidate = {
      targetId,
      cancel: () => document.removeEventListener('focusin', onFocus),
    };
  }

  cancelFocus() {
    this.candidate?.cancel();
    this.candidate = null;
    if (this.pending?.focus) this.pending = { ...this.pending, focus: false };
  }

  stayed() {
    this.cancelFocus();
  }

  prepareDeparture(
    source: CreatorStatementsAddress,
    page: Page,
    sourceToken: string,
    href: string,
    isCurrent: boolean,
  ): boolean {
    const target = parseAddress(href, source.locale);
    if (!target) {
      this.reset();
      return true;
    }
    if (sameStatementsAddress(source, target)) return true;
    if (!isCurrent) return false;

    let movement: Movement | undefined;
    if (source.kind === 'list' && target.kind === 'list') {
      const path = this.list?.current === source.cursor ? this.list : undefined;
      if (page.kind === 'ready' && 'payoutStatements' in page && page.next && target.cursor === page.next)
        movement = 'list-next';
      else if (target.cursor === previous(path, source, this.pending)) {
        movement =
          this.pending?.movement === 'list-next' && target.cursor === this.pending.source.cursor
            ? 'list-restore'
            : 'list-previous';
      } else if (target.cursor === null && source.cursor !== null) movement = 'list-restart';
    } else if (source.kind === 'list' && target.kind === 'detail') {
      const rowIsCurrent =
        page.kind === 'ready' &&
        'payoutStatements' in page &&
        page.payoutStatements.some((statement) => statement.id === target.id);
      if (rowIsCurrent && target.cursor === null && target.from === source.cursor) movement = 'open';
    } else if (
      source.kind === 'detail' &&
      target.kind === 'detail' &&
      source.id === target.id &&
      source.from === target.from
    ) {
      const path =
        this.lines?.statementId === source.id && this.lines.current === source.cursor ? this.lines : undefined;
      if (
        linesReady(page, source) &&
        page.kind === 'ready' &&
        'statement' in page &&
        page.lines.kind === 'ready' &&
        page.lines.next &&
        target.cursor === page.lines.next
      )
        movement = 'line-next';
      else if (target.cursor === previous(path, source, this.pending)) {
        movement =
          this.pending?.movement === 'line-next' && target.cursor === this.pending.source.cursor
            ? 'line-restore'
            : 'line-previous';
      } else if (target.cursor === null && source.cursor !== null) movement = 'line-restart';
    } else if (source.kind === 'detail' && target.kind === 'list' && target.cursor === source.from) movement = 'return';

    if (!movement) {
      this.reset();
      return true;
    }
    const targetId = encodeAddress(target);
    const focus =
      (movement.startsWith('list-') || movement.startsWith('line-')) && this.candidate?.targetId === targetId;
    this.pending = { movement, source, target, focus: !!focus };
    this.route = source;
    this.source = sourceToken;
    if (!focus) this.cancelFocus();
    this.publish();
    return true;
  }
}

const stores = new WeakMap<object, CreatorStatementWindows>();

export function creatorStatementWindows(owner: object, identity: string) {
  let visit = stores.get(owner);
  if (!visit || visit.identity !== identity) {
    visit?.reset();
    visit = new CreatorStatementWindows(identity);
    stores.set(owner, visit);
  }
  return visit;
}
