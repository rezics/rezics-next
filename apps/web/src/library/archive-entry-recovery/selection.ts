/** Local intent only. These types do not describe or replace a native HTTP DTO. */
export type RecoverySection = 'entries' | 'labels' | 'assignments';
export type RecoveryChoice<T> = Readonly<{ ordinal: number; section: RecoverySection; choice: T }>;

export const recoverySelectionLimit = 20;
export const recoveryPageLimit = 100;

/** Local projection of one native page; the adapter keeps its generated envelope as context. */
export type RecoveryPage<Row, Context> = Readonly<{ rows: readonly Row[]; context: Context }>;

export function ownRecoveryPage<Row, Context>(page: RecoveryPage<Row, Context>): RecoveryPage<Row, Context> {
  if (page.rows.length > recoveryPageLimit) throw new Error('page_limit');
  return ownRecoveryValue(page);
}

/** Own a JSON DTO so callers cannot mutate a confirmed operand through an earlier reference. */
export function ownRecoveryValue<T>(value: T): T {
  let copy: T;
  try {
    copy = structuredClone(value);
  } catch {
    throw new Error('invalid_private_value');
  }
  const seen = new WeakSet<object>();
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}

/** One bounded selection, independent of the archive's size and the currently displayed page. */
export class RecoverySelection<T> {
  #choices = new Map<number, RecoveryChoice<T>>();
  #revision = 0;

  get revision() {
    return this.#revision;
  }

  get choices(): readonly RecoveryChoice<T>[] {
    return Object.freeze([...this.#choices.values()]);
  }

  set(ordinal: number, section: RecoverySection, choice: T): void {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !['entries', 'labels', 'assignments'].includes(section))
      throw new Error('invalid_selection');
    if (!this.#choices.has(ordinal) && this.#choices.size >= recoverySelectionLimit) throw new Error('selection_limit');
    this.#choices.set(ordinal, ownRecoveryValue({ ordinal, section, choice }));
    this.#revision++;
  }

  remove(ordinal: number): void {
    if (this.#choices.delete(ordinal)) this.#revision++;
  }

  clear(): void {
    this.#choices.clear();
    this.#revision++;
  }
}
