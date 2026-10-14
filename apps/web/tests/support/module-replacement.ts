import { mock } from 'bun:test';

type Replacements<T> = {
  [Key in keyof T as T[Key] extends (...args: never[]) => unknown ? Key : never]?:
    (...args: never[]) => unknown;
};

/** Call once at file top level with import.meta.resolve(specifier) and a real-export snapshot.
 * Only functions can change: value exports keep their real identity and are refused in the table.
 * The returned cleanup resets delegates; .set changes them without replacing the module again.
 */
export function replaceModule<T extends Record<string, unknown>>(specifier: string, exports: T, replacements: Replacements<T>) {
  const real: Record<string, unknown> = { ...exports };
  const keys = Object.keys(replacements);
  let current = { ...real };
  const set = (next: Replacements<T>) => {
    for (const [key, value] of Object.entries(next)) {
      if (!Object.hasOwn(real, key) || typeof real[key] !== 'function' || typeof value !== 'function') {
        throw new TypeError(`Module replacement requires a real function export: ${key}`);
      }
      if (!keys.includes(key)) throw new TypeError(`Module replacement did not install a delegate for: ${key}`);
    }
    current = { ...real, ...next };
  };
  set(replacements);
  const replacement = { ...real };
  for (const key of keys) {
    replacement[key] = function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(current[key] as (...args: unknown[]) => unknown, this, args);
    };
  }
  void mock.module(specifier, () => replacement);
  return Object.assign(() => { current = { ...real }; }, { set });
}
