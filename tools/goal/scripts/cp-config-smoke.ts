#!/usr/bin/env bun
/**
 * Candidate pre-publication gate: parse the live local settings and the routing table they name with this checkout's
 * loaders. Uses `checkSettings` (strict, no last-valid snapshot) so the gate cannot write live controller state,
 * launch workers or signal processes.
 */
import { checkSettings, settingsFile, type SettingsOptions } from '../src/config.ts';
import { readRouting } from '../src/routing.ts';

function diagnose(source: string, error: unknown): Error {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return new Error(`${source}: ${message}`);
}

/** Parse the configured live local file and routing table. Throws naming the source and incompatible field. */
export function checkLiveConfiguration(options: SettingsOptions = {}): { localFile: string; routingFile: string } {
  const localFile = settingsFile(options);
  let settings;
  try {
    settings = checkSettings(options);
  } catch (error) {
    throw diagnose(localFile, error);
  }
  try {
    readRouting(settings.routingFile);
  } catch (error) {
    throw diagnose(settings.routingFile, error);
  }
  return { localFile: settings.localFile, routingFile: settings.routingFile };
}

if (import.meta.main) {
  try {
    const checked = checkLiveConfiguration();
    console.log(`cp-config-smoke: parsed ${checked.localFile} and ${checked.routingFile}`);
  } catch (error) {
    console.error(`cp-config-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
