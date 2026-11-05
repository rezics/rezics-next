import type { ConnectionStream } from '../../pages/subject-connections';

export type CharacterWorkKind = 'appearance' | 'performance';

/** Only streams already admitted by the current release enter this presentation. No inverse aliases. */
export function characterWorkStream(stream: ConnectionStream, character: string): CharacterWorkKind | undefined {
  if (stream.direction !== 'in') return;
  if (stream.group === 'characters' && stream.property === 'schema:character' && !stream.filter) return 'appearance';
  if (
    stream.group === 'credits' &&
    stream.property === 'wdt:P725' &&
    stream.qualifier === 'wdt:P453' &&
    stream.filter === character
  )
    return 'performance';
}
