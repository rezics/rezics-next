// Stories evaluate the production reader, whose address client imports `node:net`
// only to recognize a forwarded IP. The browser has no `node:net`. This stand-in
// is enough for that module to load; the recorded visit does not call it.

const ipv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIP(value: string): 0 | 4 | 6 {
  if (ipv4.test(value)) return 4;
  if (value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value)) return 6;
  return 0;
}
