import { isIP } from 'node:net';

/**
 * Server only: whether `value` is an IPv4 or IPv6 literal. The BFF forwards a client address to Main only when
 * it is one. `node:net` stays out of `features/`, which the browser can load.
 */
export const isClientIp = (value: string): boolean => isIP(value) !== 0;
