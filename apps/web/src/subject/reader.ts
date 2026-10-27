/** What the reader chose about spoilers and withheld covers; the page applies it, the kernel only stores it. */
export type Reader = { spoilerLevel: 0 | 1 | 2; suitability: 'blur' | 'show' };

/** Anonymous readers, and anyone whose setting cannot be read, get the safe defaults. */
export const defaultReader: Reader = { spoilerLevel: 0, suitability: 'blur' };
