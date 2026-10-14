// Stories load production readers in the browser. The worker module uses
// node:net, which Vite externalizes. A story request has no ingress address.

const octet = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Same answer as `node:net` `isIP` for the literals the ingress forwards. */
export function isClientIp(value: string): boolean {
  if (value.split('.').length === 4 && value.split('.').every(part => octet.test(part))) return true;
  return value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value);
}
