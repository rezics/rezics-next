import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';

/** Original immutable source identity, before any deletion generation exists. */
export type RecordHistorySourceReference =
  | Readonly<{ kind: 'contribution'; subjectId: string; candidateId: string; revision: number; documentId: string | null }>
  | Readonly<{ kind: 'context'; contextId: string }>
  | Readonly<{ kind: 'zone'; zoneId: string }>;

export const MAX_COMMAND_RECORD_SOURCES = 16;
const declarations = new WeakMap<CommandTransaction, readonly RecordHistorySourceReference[]>();

export function recordHistorySourceKey(input: RecordHistorySourceReference): string {
  const uuid = (id: string) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
  if (input.kind === 'contribution') {
    if (Object.keys(input).length !== 5 || !uuid(input.subjectId) || !uuid(input.candidateId) ||
      routeOf(input.subjectId) !== routeOf(input.candidateId) || !Number.isSafeInteger(input.revision) ||
      input.revision < 1 || (input.documentId !== null && (!uuid(input.documentId) ||
      routeOf(input.documentId) !== routeOf(input.subjectId)))) throw new TypeError('Invalid original record source');
    return JSON.stringify(['contribution', input.subjectId, input.candidateId, input.revision, input.documentId]);
  }
  if (input.kind === 'context' && Object.keys(input).length === 2 && uuid(input.contextId))
    return JSON.stringify(['context', input.contextId]);
  if (input.kind === 'zone' && Object.keys(input).length === 2 && uuid(input.zoneId))
    return JSON.stringify(['zone', input.zoneId]);
  throw new TypeError('Invalid original record source');
}

/** Native source writers call before serialization on the REAL command transaction. This is
 * ownership association only: neither permission, source validity nor historical completeness.
 * Declare old, new and current immutable references separately when the command copies each. */
export function declareCommandRecordSources(
  tx: CommandTransaction,
  sources: readonly RecordHistorySourceReference[],
): void {
  currentCommand(tx);
  if (declarations.has(tx) || sources.length < 1 || sources.length > MAX_COMMAND_RECORD_SOURCES)
    throw new TypeError('Invalid or repeated command record source declaration');
  const keys = sources.map(recordHistorySourceKey);
  if (new Set(keys).size !== sources.length) throw new TypeError('Repeated original record source');
  declarations.set(tx, Object.freeze(sources.map((source) => Object.freeze({ ...source }))));
}

export function commandRecordSources(tx: CommandTransaction): readonly RecordHistorySourceReference[] {
  return declarations.get(tx) ?? [];
}

export function releaseCommandRecordSources(tx: CommandTransaction): void {
  declarations.delete(tx);
}
