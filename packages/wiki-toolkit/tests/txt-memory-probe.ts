// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
const file = process.argv[2]!;
process.argv = ['bun', 'rezics-wiki', 'units', file];
await import('../src/cli.ts');
// Linux resourceUsage can retain a fork parent's RSS high-water mark across exec.
// VmHWM measures this CLI's current address space rather than the enclosing test suite.
const status = readFileSync('/proc/self/status', 'utf8');
const maxRssKiB = Number(/^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1]);
process.stderr.write(JSON.stringify({ maxRssKiB }));
