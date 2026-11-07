import { spoilerLevel } from '../../../pages/shared';
import { m } from '../../../../paraglide/messages.js';
import type { GameClassificationReturn } from '../../game-current-visit-descriptor';
import type { GameReaderAddress, GameReaderRead, GameReaderReady, GameStatement } from '../model';

export type GameReaderReturnKind =
  | 'pending'
  | 'changed'
  | 'removed'
  | 'concealed'
  | 'unavailable'
  | 'withheld'
  | 'unknown'
  | 'no-value'
  | 'unsupported'
  | 'current';

export type GameReaderReturnResult =
  | { kind: Exclude<GameReaderReturnKind, 'current'> }
  | { kind: 'current'; statement: GameStatement };

type ReturnAddress = Pick<GameReaderAddress, 'id' | 'context' | 'type'> & {
  locale: string;
  realm?: string | undefined;
  reader: string | null;
  spoiler?: number | undefined;
};

/** A return names one current classification assertion; a mismatch is never repaired into another row. */
export function resolveGameReaderReturn(
  address: ReturnAddress,
  selection: GameClassificationReturn,
  page: GameReaderReady | undefined,
  failure: GameReaderRead | undefined,
): GameReaderReturnResult {
  if (
    selection.holder.toLowerCase() !== address.id.toLowerCase() ||
    selection.context !== address.context ||
    selection.type !== address.type ||
    selection.locale !== address.locale ||
    selection.realm !== address.realm ||
    selection.reader !== address.reader
  )
    return { kind: 'changed' };
  if (!page) {
    if (!failure) return { kind: 'pending' };
    if (failure.ok) return { kind: 'pending' };
    return failure.reason === 'withheld'
      ? { kind: 'withheld' }
      : failure.reason === 'invalid'
        ? { kind: 'unknown' }
        : failure.reason === 'restart'
          ? { kind: 'changed' }
          : { kind: 'unavailable' };
  }
  if (
    page.public.subject.id !== address.id ||
    page.public.subject.context !== address.context ||
    page.public.subject.type !== address.type ||
    page.digest !== selection.release
  )
    return { kind: 'changed' };
  if (!page.admitted) return { kind: 'unsupported' };
  if (!page.labels[selection.property]) return { kind: 'unknown' };
  const classification = page.groups.find((group) => group.id === 'classification');
  const field = classification?.fields.find((candidate) => candidate.property === selection.property);
  if (!field) return { kind: 'unsupported' };
  if (!field.statements.length) return { kind: 'no-value' };
  const statement = field.statements.find((candidate) => candidate.id === selection.statement);
  if (!statement) return { kind: 'removed' };
  if (spoilerLevel(statement) > (address.spoiler ?? 0)) return { kind: 'concealed' };
  return { kind: 'current', statement };
}

export function gameReaderReturnMessage(
  kind: Exclude<GameReaderReturnKind, 'pending' | 'current'>,
  o: { locale: never },
) {
  return kind === 'changed'
    ? m.game_visit_selection_changed({}, o)
    : kind === 'removed'
      ? m.game_visit_selection_removed({}, o)
      : kind === 'concealed'
        ? m.game_visit_selection_concealed({}, o)
        : kind === 'unavailable'
          ? m.game_visit_selection_unavailable({}, o)
          : kind === 'withheld'
            ? m.game_visit_selection_withheld({}, o)
            : kind === 'unknown'
              ? m.game_visit_selection_unknown({}, o)
              : kind === 'no-value'
                ? m.game_visit_selection_no_value({}, o)
                : m.game_visit_selection_unsupported({}, o);
}
