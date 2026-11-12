import type { HostedReadingPort } from './contract/hosted-reading.ts';
export declare function bindHostedReadingPort(value: HostedReadingPort): HostedReadingPort;
export declare function peekHostedReadingPort(): HostedReadingPort | undefined;
export declare function requireHostedReadingPort(): HostedReadingPort;
export declare function unbindHostedReadingPort(): void;
