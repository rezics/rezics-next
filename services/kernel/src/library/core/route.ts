/** UUID route extraction. Duplicates the Platform helper so core stays free of adapter imports. */

const ROUTABLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function routeOf(id: string): number | null {
  if (typeof id !== 'string' || !ROUTABLE_UUID.test(id)) return null;
  const hex = id.replaceAll('-', '');
  return (Number.parseInt(hex.slice(20, 22), 16) << 8) | Number.parseInt(hex.slice(22, 24), 16);
}

export function partitionOf(route: number): number {
  return route >>> 4;
}
