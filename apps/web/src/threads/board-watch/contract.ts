export type BoardWatchAdvice = 'available' | 'denied' | 'not-applicable';

export type BoardWatchPage = Readonly<{
  boardId: string;
  accountId: string;
  viewer: Readonly<{ state: 'current'; watching: boolean; revision: number }>;
  actions: Readonly<{ watch: BoardWatchAdvice; unwatch: BoardWatchAdvice }>;
  source: Readonly<{ epoch: number; position: string }>;
}>;

export type BoardWatchReadRequest = Readonly<{
  boardId: string;
  accountId: string;
  csrfToken: string;
  isCurrent?: () => boolean;
}>;

export type BoardWatchCommand = BoardWatchReadRequest &
  Readonly<{ watching: boolean; expectedRevision: number; idempotencyKey: string }>;

export type BoardWatchReadResult =
  | Readonly<{ kind: 'current'; page: BoardWatchPage }>
  | Readonly<{ kind: 'access-lost' | 'conflict' | 'unavailable' | 'unknown' }>;

export type BoardWatchCommandResult =
  | Readonly<{ kind: 'acknowledged'; watching: boolean; revision: number }>
  | Readonly<{ kind: 'conflict' | 'unknown' }>
  | Readonly<{ kind: 'refused'; reason: 'access-lost' | 'denied' | 'unavailable' }>;

export type BoardWatchNative = Readonly<{
  read(request: BoardWatchReadRequest): Promise<BoardWatchReadResult>;
  set(command: BoardWatchCommand): Promise<BoardWatchCommandResult>;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The pending publication's local consumer seam accepts only the mounted, closed companion DTO. */
export function decodeBoardWatchPage(value: unknown, boardId: string, accountId: string): BoardWatchPage | null {
  if (!record(value) || !exactKeys(value, ['boardId', 'accountId', 'viewer', 'actions', 'source'])) return null;
  if (value.boardId !== boardId || value.accountId !== accountId) return null;
  if (!record(value.viewer) || !exactKeys(value.viewer, ['state', 'watching', 'revision'])) return null;
  if (
    value.viewer.state !== 'current' ||
    typeof value.viewer.watching !== 'boolean' ||
    !Number.isSafeInteger(value.viewer.revision) ||
    (value.viewer.revision as number) < 0
  )
    return null;
  if (!record(value.actions) || !exactKeys(value.actions, ['watch', 'unwatch'])) return null;
  const allowed = (item: unknown): item is BoardWatchAdvice =>
    item === 'available' || item === 'denied' || item === 'not-applicable';
  if (!allowed(value.actions.watch) || !allowed(value.actions.unwatch)) return null;
  if (
    (value.viewer.watching && value.actions.watch !== 'not-applicable') ||
    (!value.viewer.watching && value.actions.unwatch !== 'not-applicable')
  )
    return null;
  if (!record(value.source) || !exactKeys(value.source, ['epoch', 'position'])) return null;
  if (
    !Number.isSafeInteger(value.source.epoch) ||
    (value.source.epoch as number) < 0 ||
    typeof value.source.position !== 'string' ||
    !/^(0|[1-9]\d*)$/u.test(value.source.position)
  )
    return null;

  return Object.freeze({
    boardId,
    accountId,
    viewer: Object.freeze({
      state: 'current' as const,
      watching: value.viewer.watching,
      revision: value.viewer.revision as number,
    }),
    actions: Object.freeze({ watch: value.actions.watch, unwatch: value.actions.unwatch }),
    source: Object.freeze({ epoch: value.source.epoch as number, position: value.source.position }),
  });
}
