export function read(this: { prefix: string }, suffix: string) { return this.prefix + suffix; }
export function untouched() { return 'untouched'; }
export const value = { label: 'preserved' };
