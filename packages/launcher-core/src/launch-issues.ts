import type { LaunchIssue } from '@rezics/launcher-contract';

export const launchIssues = {
  account: {
    kind: 'account',
    action: 'account',
    summary: 'Sign in again or choose a saved Minecraft profile for this instance.',
  },
  java: {
    kind: 'java',
    action: 'settings',
    summary: 'Minecraft could not use the selected Java runtime. Check the Java setting.',
  },
  memory: {
    kind: 'memory',
    action: 'settings',
    summary: 'Java could not reserve or provide the requested game memory. Check the memory limit.',
  },
  installation: {
    kind: 'installation',
    action: 'repair',
    summary: 'Minecraft installation files are missing or unreadable. Verify and repair the instance.',
  },
  mods: {
    kind: 'mods',
    action: 'mods',
    summary: 'Minecraft reported missing or incompatible mods. Check the instance’s mod versions and dependencies.',
  },
  modpack: {
    kind: 'modpack',
    action: 'packs',
    summary: 'Launcher could not verify the installed Modrinth pack. Open Packs to check its files.',
  },
  saves: {
    kind: 'saves',
    action: 'saves',
    summary: 'Launcher could not verify an interrupted save restore. Open Save history for details.',
  },
  executable: {
    kind: 'executable',
    action: 'none',
    summary: 'The selected game executable could not be started. Check its location and permissions.',
  },
  crash: {
    kind: 'crash',
    action: 'none',
    summary: 'Minecraft wrote a crash report. Review the report for details.',
  },
  unknown: {
    kind: 'unknown',
    action: 'none',
    summary: 'The game could not be started. Check the recent output for details.',
  },
} as const satisfies Record<LaunchIssue['kind'], LaunchIssue>;

export const visualNovelExecutableIssue = { ...launchIssues.executable, action: 'settings' } as const;

export class LaunchFailure extends Error {
  constructor(readonly issue: LaunchIssue) {
    super(issue.summary);
  }
}

export function safeLaunchFailure(error: unknown): LaunchFailure {
  return error instanceof LaunchFailure ? error : new LaunchFailure(launchIssues.unknown);
}

const memoryFailure =
  /(?:could not reserve enough space for object heap|could not allocate enough memory for the java heap|OutOfMemoryError:\s*(?:Java heap space|GC overhead limit exceeded))/iu;
const loaderFailure =
  /(?:\bincompatible mods found\b|some of your mods are incompatible with the game or each other|missing or unsupported mandatory dependencies)/iu;
const duplicateModFailure =
  /\b(?:duplicate mods found|found duplicate mods|ModResolutionException:\s*duplicate mod)\b/iu;
const javaFailure =
  /(?:\bUnsupportedClassVersionError\b|error occurred during initialization of vm|could not create the java virtual machine)/iu;

export function processLaunchIssue(line: string): LaunchIssue | undefined {
  if (memoryFailure.test(line)) return launchIssues.memory;
  if (duplicateModFailure.test(line)) {
    return { ...launchIssues.mods, summary: 'The loader reported duplicate mods. Open Mods to review the JAR files.' };
  }
  if (loaderFailure.test(line)) return launchIssues.mods;
  if (javaFailure.test(line)) return launchIssues.java;
}
