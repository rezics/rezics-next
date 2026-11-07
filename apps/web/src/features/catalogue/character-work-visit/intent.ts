import { characterWorkStream, type CharacterConnectionStream, type CharacterWorkKind } from '../character-reading-port';

export type { CharacterWorkKind };
export type CharacterWorkStream = CharacterConnectionStream;

/** Only streams already admitted by the current release enter this presentation. No inverse aliases. */
export { characterWorkStream };
