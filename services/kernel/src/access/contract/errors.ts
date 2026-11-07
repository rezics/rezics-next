/** Shared Access refusals. Native commands and consumers use the same constructor identities. */
export class ResourceAccessWriteDeniedError extends Error {
  constructor() {
    super('Resource access write denied');
    this.name = 'ResourceAccessWriteDeniedError';
  }
}

export class GrantDeniedError extends ResourceAccessWriteDeniedError {
  constructor() {
    super();
    this.message = 'Access grant administration denied';
    this.name = 'GrantDeniedError';
  }
}

/** Only the authorized, locked native Realm holder predicate may issue this refusal. */
export class RealmLastOwnerError extends GrantDeniedError {
  constructor() {
    super();
    this.name = 'RealmLastOwnerError';
  }
}

export class ApprovalIdentityDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Approval denied');
    this.name = 'ApprovalIdentityDeniedError';
  }
}

export class DurableInitiatorUnavailableError extends Error {
  constructor() {
    super('Durable initiator restoration is unavailable');
    this.name = 'DurableInitiatorUnavailableError';
  }
}

export class PlatformClosedError extends Error {
  constructor() {
    super('Platform operation is closed');
    this.name = 'PlatformClosedError';
  }
}

export class LifecycleDeniedError extends Error {
  constructor() {
    super('Account lifecycle command denied');
    this.name = 'LifecycleDeniedError';
  }
}

/** Access could not finish; absence of evidence is not evidence of a denial. */
export class AccessUnavailableError extends Error {
  constructor(readonly reason: 'deadline' | 'overloaded' | 'contention') {
    super(`Access unavailable: ${reason}`);
    this.name = 'AccessUnavailableError';
  }
}

export class CommandUnavailableError extends Error {
  readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
  readonly partition: number;
  readonly movedTo: string | null;
  constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo: string | null = null) {
    super(`Command unavailable for partition ${partition}: ${reason}${movedTo ? ` (${movedTo})` : ''}`);
    this.name = 'CommandUnavailableError';
    this.reason = reason;
    this.partition = partition;
    this.movedTo = movedTo;
  }
}

/** Missing native admission evidence is pending, never an empty inventory or an ACK. */
export class LiveCopyPendingError extends Error {}
