import type {
  BoardWatchCommand,
  BoardWatchCommandResult,
  BoardWatchNative,
  BoardWatchPage,
  BoardWatchReadRequest,
  BoardWatchReadResult,
} from './contract';

export type BoardWatchVisitBinding = Readonly<{
  boardId: string;
  accountId: string;
  csrfToken: string;
  authorityKey: string;
  isCurrent: () => boolean;
  native: BoardWatchNative;
}>;

export type BoardWatchView = Readonly<{
  phase: 'checking' | 'current' | 'read-failed' | 'conflict' | 'denied' | 'unavailable' | 'unknown' | 'retired';
  page?: BoardWatchPage;
  command: 'none' | 'sending' | 'acknowledged' | 'unknown' | 'conflict' | 'denied';
  acknowledgement?: Readonly<{ watching: boolean; revision: number }>;
}>;

type LiveBinding = Readonly<{ value: BoardWatchVisitBinding }>;

function sameVisit(left: BoardWatchVisitBinding, right: BoardWatchVisitBinding): boolean {
  return (
    left.boardId === right.boardId &&
    left.accountId === right.accountId &&
    left.csrfToken === right.csrfToken &&
    left.authorityKey === right.authorityKey &&
    left.native === right.native
  );
}

/** One page visit owns one exact native read and immutable, replayable command operands. */
export class BoardWatchVisit {
  private view: BoardWatchView = Object.freeze({ phase: 'checking', command: 'none' });
  private readonly listeners = new Set<() => void>();
  private owner: (BoardWatchReadRequest & { isCurrent: () => boolean }) | undefined;
  private readonly original: BoardWatchVisitBinding;
  private readonly latest: () => LiveBinding;
  private started = false;
  private connected = false;
  private retired = false;
  private connection = 0;
  private active: object | undefined;
  private command: BoardWatchCommand | undefined;

  constructor(binding: BoardWatchVisitBinding, latest: () => LiveBinding) {
    this.original = binding;
    this.latest = latest;
    this.owner = Object.freeze({
      boardId: binding.boardId,
      accountId: binding.accountId,
      csrfToken: binding.csrfToken,
      isCurrent: binding.isCurrent,
    });
  }

  matches(binding: BoardWatchVisitBinding): boolean {
    return !this.retired && sameVisit(this.original, binding);
  }

  snapshot = (): BoardWatchView => this.view;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(view: BoardWatchView) {
    this.view = Object.freeze(view);
    for (const listener of this.listeners) listener();
  }

  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.connected = false;
    this.connection++;
    this.active = undefined;
    this.command = undefined;
    this.owner = undefined;
    this.publish({ phase: 'retired', command: 'none' });
  };

  private current(): boolean {
    const owner = this.owner;
    if (this.retired || !this.connected || !owner) return false;
    const live = this.latest().value;
    if (!sameVisit(this.original, live) || !owner.isCurrent?.() || !live.isCurrent()) {
      this.retire();
      return false;
    }
    return true;
  }

  connect = () => {
    if (this.retired) return () => {};
    this.connected = true;
    const ticket = ++this.connection;
    if (!this.started) {
      this.started = true;
      void this.read();
    }
    return () => {
      if (!this.connected || ticket !== this.connection) return;
      this.connected = false;
      const disconnected = ++this.connection;
      queueMicrotask(() => {
        if (!this.connected && this.connection === disconnected) this.retire();
      });
    };
  };

  canBegin = (): boolean => {
    const page = this.view.page;
    if (!this.connected || this.retired || this.view.phase !== 'current' || !page || this.active) return false;
    if (this.view.command === 'sending' || this.view.command === 'unknown' || this.view.command === 'denied')
      return false;
    const advice = page.viewer.watching ? page.actions.unwatch : page.actions.watch;
    return advice === 'available';
  };

  begin = () => {
    if (!this.canBegin() || !this.current()) return;
    const page = this.view.page!;
    const owner = this.owner!;
    const command: BoardWatchCommand = Object.freeze({
      boardId: owner.boardId,
      accountId: owner.accountId,
      csrfToken: owner.csrfToken,
      ...(owner.isCurrent ? { isCurrent: owner.isCurrent } : {}),
      watching: !page.viewer.watching,
      expectedRevision: page.viewer.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    this.command = command;
    void this.submit(command);
  };

  retry = () => {
    if (this.view.command !== 'unknown' || !this.command || !this.current() || this.active) return;
    void this.submit(this.command);
  };

  read = async () => {
    if (!this.current() || this.active) return;
    const ticket = {};
    this.active = ticket;
    const command = this.view.command;
    this.publish({
      phase: 'checking',
      command,
      ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
    });
    const owner = this.owner!;
    const request: BoardWatchReadRequest = Object.freeze({ ...owner });
    try {
      const result = await this.original.native.read(request);
      if (this.current() && this.active === ticket) this.acceptRead(result, command);
    } catch {
      if (this.current() && this.active === ticket)
        this.publish({
          phase: 'read-failed',
          command,
          ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
        });
    } finally {
      if (this.active === ticket) this.active = undefined;
    }
  };

  private acceptRead(result: BoardWatchReadResult, command: BoardWatchView['command']) {
    if (result.kind === 'current') {
      const recoveredCommand = command === 'denied' ? 'none' : command;
      this.publish({
        phase: 'current',
        page: result.page,
        command: recoveredCommand,
        ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
      });
    } else if (result.kind === 'access-lost') {
      this.command = undefined;
      this.publish({ phase: 'denied', command: 'denied' });
    } else if (result.kind === 'conflict') {
      this.publish({
        phase: 'conflict',
        command,
        ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
      });
    } else if (result.kind === 'unavailable') {
      this.publish({
        phase: 'unavailable',
        command,
        ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
      });
    } else {
      this.publish({
        phase: 'read-failed',
        command,
        ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
      });
    }
  }

  private async submit(command: BoardWatchCommand) {
    if (!this.current() || this.active) return;
    const ticket = {};
    this.active = ticket;
    this.publish({
      phase: 'current',
      ...(this.view.page ? { page: this.view.page } : {}),
      command: 'sending',
      ...(this.view.acknowledgement ? { acknowledgement: this.view.acknowledgement } : {}),
    });
    let inspectAfter = false;
    try {
      const result = await this.original.native.set(command);
      if (!this.current() || this.active !== ticket) return;
      inspectAfter = this.acceptCommand(result);
    } catch {
      if (this.current() && this.active === ticket) this.publish({ phase: 'unknown', command: 'unknown' });
    } finally {
      if (this.active === ticket) this.active = undefined;
      if (inspectAfter) void this.read();
    }
  }

  private acceptCommand(result: BoardWatchCommandResult): boolean {
    if (result.kind === 'acknowledged') {
      const acknowledgement = Object.freeze({ watching: result.watching, revision: result.revision });
      this.publish({ phase: 'checking', command: 'acknowledged', acknowledgement });
      return true;
    }
    if (result.kind === 'conflict') {
      this.publish({ phase: 'conflict', command: 'conflict' });
    } else if (result.kind === 'unknown') {
      this.publish({ phase: 'unknown', command: 'unknown' });
    } else if (result.kind === 'refused') {
      this.command = undefined;
      const reason = result.kind === 'refused' ? result.reason : undefined;
      this.publish({
        phase: reason === 'access-lost' ? 'denied' : reason === 'unavailable' ? 'unavailable' : 'denied',
        command: 'denied',
      });
    }
    return false;
  }
}
