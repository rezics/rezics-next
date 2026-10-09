import { expect, test } from 'bun:test';
import { isPublicAddress } from '../src/infrastructure/outbound-address.ts';

const refused = [
  ['loopback', '127.0.0.1'],
  ['loopback', '::1'],
  ['link-local', '169.254.169.254'],
  ['link-local', 'fe80::1'],
  ['private', '10.1.2.3'],
  ['private', '172.16.0.1'],
  ['private', '192.168.1.1'],
  ['CGNAT', '100.64.0.1'],
  ['CGNAT', '100.127.255.255'],
  ['unique-local', 'fc00::1'],
  ['unique-local', 'fd00::1'],
  ['IPv4-mapped', '::ffff:127.0.0.1'],
  ['IPv4-mapped', '::ffff:10.0.0.1'],
  ['IPv4-mapped', '::ffff:8.8.8.8'],
] as const;

test.each(refused)('%s address %s is refused', (_kind, address) => {
  expect(isPublicAddress(address)).toBe(false);
});

test('a public address passes', () => {
  expect(isPublicAddress('93.184.216.34')).toBe(true);
  expect(isPublicAddress('8.8.8.8')).toBe(true);
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
});

test('a DNS name resolving to a refused address is refused and a public answer passes', async () => {
  const answers: Record<string, string> = {
    'loopback.example': '127.0.0.1',
    'link-local.example': '169.254.169.254',
    'private.example': '10.1.2.3',
    'cgnat.example': '100.64.0.1',
    'unique-local.example': 'fd00::1',
    'mapped.example': '::ffff:192.168.0.1',
    'public.example': '93.184.216.34',
  };
  const resolve = async (host: string) => answers[host] ?? null;
  for (const host of Object.keys(answers)) {
    const address = await resolve(host);
    expect(address).not.toBeNull();
    expect(isPublicAddress(address!)).toBe(host === 'public.example');
  }
});
