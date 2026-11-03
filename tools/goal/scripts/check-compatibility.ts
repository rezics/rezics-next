#!/usr/bin/env bun
import { loadSettings } from '../src/config.ts';
import {
  checkScriptCompatibility,
  compatibilityUsageError,
  parseCompatibilityArgs,
} from '../src/check-compatibility.ts';

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const parsed = parseCompatibilityArgs(args);
  const result = parsed
    ? checkScriptCompatibility(parsed.scriptsRoot, loadSettings().policy?.nativeCommands)
    : compatibilityUsageError(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.compatible ? 0 : 1;
}
