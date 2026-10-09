import { BlockList, isIP } from 'node:net';

const nonPublic = new BlockList();
// Whole special-purpose blocks are refused, including blocks that contain
// public exceptions. Numeric checks cover every address spelling.
// https://www.iana.org/assignments/iana-ipv4-special-registry (2025-10-09)
// Reverified with the IPv6 registry on 2026-10-07.
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  nonPublic.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
// Refuse protocol, transition and documentation assignments inside global
// unicast. Mapped, translated, private and scoped addresses stay outside it.
// https://www.iana.org/assignments/iana-ipv6-special-registry (2025-10-09)
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  nonPublic.addSubnet(address, prefix, 'ipv6');

/** A public unicast address. DNS answers use the same check as literals. */
export function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !nonPublic.check(value, 'ipv4');
  return (
    family === 6 &&
    !value.includes('%') &&
    globalV6.check(value, 'ipv6') &&
    !nonPublic.check(value, 'ipv6')
  );
}
