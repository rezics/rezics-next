/** Count canonical JSON token bytes without first allocating a potentially huge serialized string. */
export function assertJsonByteBudget(value: unknown, limit: number): void {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > limit) throw new RangeError('Document snapshots may not exceed 2 MiB');
  };
  const string = (text: string) => {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index++;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
        add(2);
      else if (code < 32) add(6);
      else add(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const visit = (item: unknown): void => {
    if (item === null) {
      add(4);
      return;
    }
    if (typeof item === 'string') {
      string(item);
      return;
    }
    if (typeof item === 'boolean') {
      add(item ? 4 : 5);
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Snapshot contains non-JSON data');
    const array = Array.isArray(item);
    if (
      (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) ||
      Object.getOwnPropertySymbols(item).length
    )
      throw new TypeError('Snapshot contains non-JSON data');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && Object.keys(item).length !== item.length) throw new TypeError('Snapshot contains a sparse array');
    ancestors.add(item);
    add(2);
    let count = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Snapshot contains an accessor');
      if (count++) add(1);
      if (!array) {
        string(key);
        add(1);
      }
      visit(descriptor.value);
    }
    ancestors.delete(item);
  };
  visit(value);
}
