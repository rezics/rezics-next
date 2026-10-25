import { seal, unseal, type KeyRing } from './seal.ts';

export type SessionComponent = {
  partition: number;
  epoch: number;
  position: bigint;
};

const MAX_POSITION = 9_223_372_036_854_775_807n;
const DECIMAL_POSITION = /^(?:0|[1-9][0-9]*)$/;

function isValidComponent(value: SessionComponent): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.partition) &&
    value.partition >= 0 &&
    value.partition <= 4095 &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch >= 1 &&
    typeof value.position === 'bigint' &&
    value.position >= 0n &&
    value.position <= MAX_POSITION
  );
}

function validateComponents(components: readonly SessionComponent[]): void {
  if (!Array.isArray(components) || components.length > 32) throw new TypeError('Invalid session components');
  const partitions = new Set<number>();
  for (const component of components) {
    if (!isValidComponent(component) || partitions.has(component.partition))
      throw new TypeError('Invalid session component');
    partitions.add(component.partition);
  }
}

export function mergeSession(components: readonly SessionComponent[], write: SessionComponent): SessionComponent[] {
  if (!Array.isArray(components) || !isValidComponent(write)) throw new TypeError('Invalid session component');
  const previous = components.find((component) => component.partition === write.partition);
  if (previous && write.epoch < previous.epoch) return [...components];

  let merged: SessionComponent;
  if (previous && write.epoch === previous.epoch && write.position < previous.position) merged = previous;
  else merged = { ...write };

  const result = components.filter((component) => component.partition !== write.partition);
  result.push(merged);
  return result.slice(-32);
}

export function encodeSession(ring: KeyRing, scope: string, components: readonly SessionComponent[]): string {
  validateComponents(components);
  const payload = components.map(({ partition, epoch, position }) => [partition, epoch, position.toString()]);
  return seal(ring, `session\0${scope}`, payload);
}

export function decodeSession(ring: KeyRing, scope: string, token: string): SessionComponent[] | undefined {
  const payload = unseal(ring, `session\0${scope}`, token);
  if (!Array.isArray(payload) || payload.length > 32) return undefined;

  const result: SessionComponent[] = [];
  const partitions = new Set<number>();
  for (const item of payload) {
    if (
      !Array.isArray(item) ||
      item.length !== 3 ||
      !Number.isInteger(item[0]) ||
      item[0] < 0 ||
      item[0] > 4095 ||
      !Number.isSafeInteger(item[1]) ||
      item[1] < 1 ||
      typeof item[2] !== 'string' ||
      !DECIMAL_POSITION.test(item[2])
    )
      return undefined;

    let position: bigint;
    try {
      position = BigInt(item[2]);
    } catch {
      return undefined;
    }
    if (position > MAX_POSITION || partitions.has(item[0])) return undefined;
    partitions.add(item[0]);
    result.push({ partition: item[0], epoch: item[1], position });
  }
  return result;
}
