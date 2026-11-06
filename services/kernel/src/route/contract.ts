/** Pure route arithmetic shared by Kernel contracts and cores. Random IDs and anchors stay in route.ts. */
export const ROUTES = 65_536;
export const PARTITIONS = 4_096;

const ROUTABLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertRoute(route: number): void {
  if (!Number.isInteger(route) || route < 0 || route >= ROUTES)
    throw new RangeError('Route must be an integer from 0 to 65535');
}

export function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replaceAll('-', ''), 'hex');
}

export function partitionOf(route: number): number {
  assertRoute(route);
  return route >>> 4;
}

export function routeOf(id: string): number | null {
  if (typeof id !== 'string' || !ROUTABLE_UUID.test(id)) return null;
  const bytes = uuidBytes(id);
  return (bytes[10]! << 8) | bytes[11]!;
}
