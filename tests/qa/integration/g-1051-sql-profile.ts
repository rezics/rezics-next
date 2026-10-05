import { isForegroundOperation } from './support/operation-cost.ts';
import pg from 'pg';

/** Count protocol statements separately from table families. Parameters are
 * never recorded; the retained evidence contains query shapes only. */
export function captureSql() {
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const native = prototype.query;
  const queries: string[] = [];
  prototype.query = function (this: object, ...args: unknown[]) {
    if (isForegroundOperation()) queries.push(
      typeof args[0] === 'string'
        ? args[0]
        : ((args[0] as { text?: string } | undefined)?.text ?? ''),
    );
    return native.apply(this, args);
  };
  return {
    snapshot() {
      const families: Record<string, number> = {};
      const shapes: Record<string, number> = {};
      for (const text of queries) {
        const family = [
          ...new Set(text.match(/\b(?:access|content|media|account)\.[a-z_]+/g) ?? [text.trim()]),
        ]
          .sort()
          .join(',');
        families[family] = (families[family] ?? 0) + 1;
        shapes[text] = (shapes[text] ?? 0) + 1;
      }
      return { statements: queries.length, families, shapes };
    },
    stop() {
      prototype.query = native;
    },
  };
}
