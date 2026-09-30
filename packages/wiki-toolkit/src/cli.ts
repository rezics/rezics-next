#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseFile, parseLocator } from './index.ts';

try {
  const args = process.argv.slice(2);
  const command = args.shift(),
    file = args.shift();
  const locator = command === 'verify' ? args.shift() : undefined;
  let encoding: string | undefined;
  if (args[0] === '--encoding' && args.length === 2) {
    encoding = args[1];
    args.splice(0);
  }
  if (
    !file ||
    !['units', 'verify'].includes(command ?? '') ||
    args.length ||
    (command === 'verify' && !locator)
  ) {
    throw new Error(
      'Usage: rezics-wiki units <file> [--encoding <name>] | rezics-wiki verify <file> <locator-json> [--encoding <name>]',
    );
  }
  const extension = extname(file).slice(1).toLowerCase();
  if (extension !== 'txt' && extension !== 'epub' && extension !== 'rpy')
    throw new Error('Unsupported input; expected .txt, .epub or literal .rpy');
  if (encoding && extension !== 'txt') throw new Error('--encoding is supported only for TXT');
  const parsed = parseFile(readFileSync(file), extension, { encoding });
  if (command === 'units')
    for (const unit of parsed.units) process.stdout.write(`${JSON.stringify(unit)}\n`);
  else
    process.stdout.write(
      `${JSON.stringify(parsed.verify(parseLocator(JSON.parse(locator === '-' ? readFileSync(0, 'utf8') : locator!))))}\n`,
    );
} catch (error) {
  process.stderr.write(
    `rezics-wiki: ${error instanceof Error ? error.message : 'Unable to parse input'}\n`,
  );
  process.exitCode = 1;
}
