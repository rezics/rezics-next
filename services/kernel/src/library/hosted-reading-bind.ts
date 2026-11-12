import type { HostedReadingPort } from './contract/hosted-reading.ts';

let port: HostedReadingPort | undefined;

export function bindHostedReadingPort(value: HostedReadingPort): HostedReadingPort {
  port = value;
  return value;
}

export function peekHostedReadingPort(): HostedReadingPort | undefined {
  return port;
}

export function requireHostedReadingPort(): HostedReadingPort {
  if (!port) throw new TypeError('Hosted reading Content port is not composed');
  return port;
}

export function unbindHostedReadingPort(): void {
  port = undefined;
}
