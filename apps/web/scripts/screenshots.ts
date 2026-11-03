import { stat } from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { placeWebCheck } from './check-placement.ts';
import { operatorEntry } from './operator-entry.ts';

export { observeStorybook, settle };

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const themes = ['light', 'dark'] as const;
// Only the width is a command option. 720 is the review viewport height.
const viewportHeight = 720;
const captureLimit = 4;
const buildTimeout = 480_000;
const cleanupTimeout = 5_000;
const buildOutputLimit = 24_000;

type Theme = (typeof themes)[number];
type Options = {
  stories: string[];
  locales: string[];
  themes: Theme[];
  widths: number[];
  out: string;
  help: boolean;
};
type Job = { id: string; locale: string; theme: string; width?: number; widthSuffix?: boolean };
type CaptureFailure = { job: Job; error: string };
type CaptureResult = { files: string[]; failures: CaptureFailure[] };
export type StoryOutcome = {
  storyId: string;
  renderId?: number;
  cycle: number;
  phase?: string;
  status?: string;
  errors: string[];
};
export type StoryPreview = {
  __STORYBOOK_PREVIEW__?: {
    currentRender?: { id: string; renderId: number; phase?: string; abortController: { signal: AbortSignal } };
  };
  __STORYBOOK_ADDONS_CHANNEL__?: { on: <T>(event: string, listener: (data: T) => void) => void };
  __REZICS_STORY_OUTCOME__?: { read: () => StoryOutcome | undefined };
};

type ProgressReporter = ReturnType<typeof createProgressReporter>;

type CloseResult = void | boolean;
type CleanupIssue = { label: string; message: string };
type CleanupReport = { issues: CleanupIssue[]; unproved: string[] };
type LeaseRecord<T> = {
  label: string;
  close: (value: T) => CloseResult | Promise<CloseResult>;
  acquired?: Promise<T>;
  value?: T;
  hasValue: boolean;
  closePromise?: Promise<string | undefined>;
  state: 'acquiring' | 'active' | 'closing' | 'closed' | 'failed' | 'unproved';
};

type TemporarySite = { port: number; close: () => CloseResult | Promise<CloseResult> };

export type ScreenshotRuntime = {
  spawn?: typeof Bun.spawn;
  serve: (directory: string) => TemporarySite | Promise<TemporarySite>;
  launch: () => Promise<Browser>;
  readStories: (directory: string) => Promise<string[]>;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  rm: typeof rm;
  buildTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  signals?: {
    listen: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => () => void;
  };
  setExitCode?: (code: number) => void;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  progress?: (write: (line: string) => void) => ProgressReporter;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, limit = 4_000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [truncated ${value.length - limit} characters]`;
}

function abortedError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Capture retired.'));
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortedError(signal));
  return new Promise<T>((resolve, reject) => {
    const remove = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      remove();
      reject(abortedError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        remove();
        resolve(value);
      },
      (error: unknown) => {
        remove();
        reject(error);
      },
    );
  });
}

/** Retires a page operation only after it settles, so page close can prove the job has drained. */
function waitForRetirement<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let retired = signal.aborted;
    const remove = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      retired = true;
      remove();
    };
    if (!retired) signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        remove();
        if (retired || signal.aborted) reject(abortedError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        remove();
        if (retired || signal.aborted) reject(abortedError(signal));
        else reject(error);
      },
    );
  });
}

type Bounded<T> = { state: 'fulfilled'; value: T } | { state: 'rejected'; error: unknown } | { state: 'timeout' };

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<Bounded<T>> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(
      () => {
        if (finished) return;
        finished = true;
        resolve({ state: 'timeout' });
      },
      Math.max(1, timeoutMs),
    );
    promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ state: 'fulfilled', value });
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ state: 'rejected', error });
      },
    );
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Storybook build timed out.')), Math.max(1, timeoutMs));
    });
    return await waitForSignal(Promise.race([promise, deadline]), signal);
  } finally {
    clearTimeout(timer);
  }
}

class ResourceRegistry {
  private readonly controller = new AbortController();
  private readonly records: LeaseRecord<unknown>[] = [];
  private accepting = true;
  private retirement: Promise<CleanupReport> | undefined;
  private removeParentListener: (() => void) | undefined;

  constructor(
    private readonly label: string,
    private readonly timeoutMs: number,
    private readonly isParentOpen: () => boolean = () => true,
    parentSignal?: AbortSignal,
  ) {
    if (parentSignal) {
      const retire = () => void this.retire('Parent capture retired.');
      if (parentSignal.aborted) retire();
      else {
        parentSignal.addEventListener('abort', retire, { once: true });
        this.removeParentListener = () => parentSignal.removeEventListener('abort', retire);
      }
    }
  }

  get open(): boolean {
    return this.accepting && this.isParentOpen() && !this.controller.signal.aborted;
  }

  acquire<T>(
    label: string,
    acquire: () => T | Promise<T>,
    close: (value: T) => CloseResult | Promise<CloseResult>,
  ): Promise<T> {
    if (!this.open) return Promise.reject(new Error(`${this.label} is retired; cannot acquire ${label}.`));
    const record: LeaseRecord<T> = {
      label,
      close,
      hasValue: false,
      state: 'acquiring',
    };
    this.records.push(record as LeaseRecord<unknown>);
    const acquired = Promise.resolve()
      .then(() => {
        if (!this.open) throw new Error(`${this.label} retired before ${label} acquisition started.`);
        return acquire();
      })
      .then(
        (value) => {
          record.value = value;
          record.hasValue = true;
          if (!this.open) {
            record.state = 'closing';
            void this.closeRecord(record);
            throw new Error(`${this.label} retired while acquiring ${label}.`);
          }
          record.state = 'active';
          return value;
        },
        (error: unknown) => {
          record.state = 'failed';
          throw error;
        },
      );
    record.acquired = acquired;
    void acquired.catch(() => undefined);
    return waitForSignal(acquired, this.controller.signal);
  }

  retire(reason = `${this.label} retired.`): Promise<CleanupReport> {
    if (this.retirement) return this.retirement;
    this.accepting = false;
    this.removeParentListener?.();
    this.removeParentListener = undefined;
    this.controller.abort(new Error(reason));
    const tasks = this.records.map((record) => this.retireRecord(record));
    this.retirement = Promise.all(tasks).then((reports) => ({
      issues: reports.flatMap((report) => report.issues),
      unproved: reports.flatMap((report) => report.unproved),
    }));
    return this.retirement;
  }

  private closeRecord<T>(record: LeaseRecord<T>): Promise<string | undefined> {
    if (record.closePromise) return record.closePromise;
    if (!record.hasValue) return Promise.resolve(undefined);
    record.state = 'closing';
    record.closePromise = Promise.resolve()
      .then(() => record.close(record.value as T))
      .then(
        (result) => {
          if (result === false) {
            record.state = 'unproved';
            return `${record.label} returned with active readers.`;
          }
          record.state = 'closed';
          return undefined;
        },
        (error: unknown) => {
          record.state = 'unproved';
          return errorMessage(error);
        },
      );
    return record.closePromise;
  }

  private async retireRecord(record: LeaseRecord<unknown>): Promise<CleanupReport> {
    if (record.hasValue) return this.waitForClose(record);
    if (record.state === 'failed') return { issues: [], unproved: [] };
    const acquired = await bounded(record.acquired!, this.timeoutMs);
    if (acquired.state === 'timeout') {
      const message = `${record.label} acquisition did not settle within ${this.timeoutMs}ms.`;
      return { issues: [{ label: record.label, message }], unproved: [message] };
    }
    if (record.hasValue) return this.waitForClose(record);
    return { issues: [], unproved: [] };
  }

  private async waitForClose(record: LeaseRecord<unknown>): Promise<CleanupReport> {
    const closing = this.closeRecord(record);
    const result = await bounded(closing, this.timeoutMs);
    if (result.state === 'timeout') {
      const message = `${record.label} close did not settle within ${this.timeoutMs}ms.`;
      record.state = 'unproved';
      return { issues: [{ label: record.label, message }], unproved: [message] };
    }
    if (result.state === 'rejected') {
      const message = `${record.label} close failed: ${errorMessage(result.error)}`;
      record.state = 'unproved';
      return { issues: [{ label: record.label, message }], unproved: [message] };
    }
    if (result.value) {
      const message = `${record.label} close failed: ${result.value}`;
      return { issues: [{ label: record.label, message }], unproved: [message] };
    }
    return { issues: [], unproved: [] };
  }
}

class CaptureLifecycleFailure extends Error {
  constructor(
    readonly primary: unknown,
    readonly cleanupFailures: readonly string[],
    readonly buildDirectoryDisposition?: {
      path: string;
      state: 'retained' | 'unknown';
      reasons: readonly string[];
    },
    readonly exitCode?: number,
  ) {
    const sections: string[] = [];
    if (primary !== undefined) sections.push(`Primary failure: ${boundedText(errorMessage(primary))}`);
    if (cleanupFailures.length)
      sections.push(`Cleanup failures:\n${cleanupFailures.map((failure) => `- ${boundedText(failure)}`).join('\n')}`);
    if (buildDirectoryDisposition)
      sections.push(
        `Build directory ${buildDirectoryDisposition.state} at ${buildDirectoryDisposition.path} because ${buildDirectoryDisposition.reasons.join('; ')}.`,
      );
    super(sections.join('\n'));
    this.name = 'CaptureLifecycleFailure';
  }
}

/** Writes capture progress to stderr while leaving stdout available for the file list. */
export function createProgressReporter(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  now: () => number = Date.now,
) {
  let buildStartedAt: number | undefined;
  return {
    buildStarted() {
      buildStartedAt = now();
      write('Storybook build started.');
    },
    buildFinished() {
      const duration = buildStartedAt === undefined ? 0 : Math.max(0, now() - buildStartedAt);
      write(`Storybook build finished in ${(duration / 1_000).toFixed(1)}s.`);
      buildStartedAt = undefined;
    },
    captured(index: number, total: number, file: string) {
      write(`captured ${index}/${total} ${file}`);
    },
  };
}

function usage(): string {
  return 'Usage: bun run screenshots [--operator] [--story <id or glob>] [--locale <code>]... [--theme light|dark]... [--width <px>]... [--out <dir>]';
}

function unique<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function storyMatches(id: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return id === pattern;
  const expression = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')}$`;
  return new RegExp(expression).test(id);
}

function selectStories(
  availableStories: readonly string[],
  selectors: readonly string[],
): { stories: string[]; unmatchedSelectors: string[] } {
  const unmatchedSelectors = selectors.filter((selector) => !availableStories.some((id) => storyMatches(id, selector)));
  const stories = availableStories
    .filter((id) => selectors.length === 0 || selectors.some((selector) => storyMatches(id, selector)))
    .sort();
  return { stories, unmatchedSelectors };
}

export function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    stories: [],
    locales: [],
    themes: [],
    widths: [],
    out: resolve(root, '.temp/screenshots'),
    help: false,
  };
  const take = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${usage()}\nMissing value for ${flag}.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--story') {
      const story = take(flag, index);
      index += 1;
      if (story === '') throw new Error(`${usage()}\nMissing story id.`);
      options.stories.push(story);
      continue;
    }
    if (flag === '--locale') {
      const locale = take(flag, index);
      index += 1;
      if (locale === '') throw new Error(`${usage()}\nMissing locale code.`);
      options.locales.push(locale);
      continue;
    }
    if (flag === '--theme') {
      const theme = take(flag, index);
      index += 1;
      if (theme !== 'light' && theme !== 'dark') throw new Error(`${usage()}\nUnknown theme ${theme}.`);
      options.themes.push(theme);
      continue;
    }
    if (flag === '--width') {
      const width = Number(take(flag, index));
      index += 1;
      if (!Number.isInteger(width) || width <= 0) throw new Error(`${usage()}\nWidth must be a positive integer.`);
      options.widths.push(width);
      continue;
    }
    if (flag === '--out') {
      const value = take(flag, index);
      // A relative directory is from the workspace root, so a check host writes into its copy of the same path.
      options.out = isAbsolute(value) ? resolve(value) : resolve(root, value);
      index += 1;
      continue;
    }
    throw new Error(`${usage()}\nUnknown argument ${flag}.`);
  }
  if (options.locales.length === 0) options.locales = [...locales];
  if (options.themes.length === 0) options.themes = [...themes];
  options.stories = unique(options.stories);
  options.locales = unique(options.locales);
  options.themes = unique(options.themes);
  options.widths = unique(options.widths.length === 0 ? [1280] : options.widths);
  return options;
}

function safePath(directory: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded.replace(/^\/+/, '');
  if (relativePath.split('/').includes('..')) return undefined;
  const target = resolve(directory, relativePath);
  if (target !== directory && !target.startsWith(`${directory}/`)) return undefined;
  return target;
}

export function screenshotFilename(job: Job): string {
  const width = job.widthSuffix && job.width !== undefined ? `.${job.width}px` : '';
  return `${job.id}.${job.locale}.${job.theme}${width}.png`;
}

function serve(directory: string): TemporarySite {
  let accepting = true;
  let activeRequests = 0;
  const idleWaiters: (() => void)[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!accepting) return new Response(null, { status: 503 });
      activeRequests += 1;
      try {
        const target = safePath(directory, new URL(request.url).pathname);
        if (!target) return new Response(null, { status: 400 });
        const info = await stat(target).catch(() => undefined);
        if (!info) return new Response(null, { status: 404 });
        const file = info.isDirectory() ? join(target, 'index.html') : target;
        if (!(await Bun.file(file).exists())) return new Response(null, { status: 404 });
        return new Response(Bun.file(file));
      } finally {
        activeRequests -= 1;
        if (activeRequests === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
      }
    },
  });
  return {
    port: server.port!,
    async close() {
      accepting = false;
      await server.stop(true);
      if (activeRequests === 0) return true;
      return await new Promise<boolean>((resolve) => idleWaiters.push(() => resolve(true)));
    },
  };
}

async function readBoundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      const remaining = Math.max(0, buildOutputLimit - bytes);
      if (remaining > 0) output += decoder.decode(chunk.subarray(0, remaining), { stream: true });
      if (chunk.byteLength > remaining) truncated = true;
      bytes += chunk.byteLength;
      if (remaining === 0) decoder.decode(chunk, { stream: true });
    }
    output += decoder.decode();
    return truncated ? `${output}\n[build output truncated after ${buildOutputLimit} bytes]` : output;
  } finally {
    reader.releaseLock();
  }
}

async function build(
  directory: string,
  cacheDir: string,
  progress: ProgressReporter,
  signal: AbortSignal,
  runtime: Pick<ScreenshotRuntime, 'spawn' | 'mkdir' | 'buildTimeoutMs' | 'cleanupTimeoutMs'>,
): Promise<void> {
  const storybook = join(app, 'node_modules/.bin/storybook');
  await runtime.mkdir(cacheDir, { recursive: true });
  if (signal.aborted) throw abortedError(signal);
  progress.buildStarted();
  const settings = {
    cwd: app,
    stdin: 'ignore' as const,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1', CACHE_DIR: cacheDir },
  };
  const child = runtime.spawn
    ? runtime.spawn(
        [storybook, 'build', '--test', '--output-dir', directory, '--disable-telemetry', '--quiet'],
        settings,
      )
    : Bun.spawn([storybook, 'build', '--test', '--output-dir', directory, '--disable-telemetry', '--quiet'], settings);
  const stdout = readBoundedOutput(child.stdout);
  const stderr = readBoundedOutput(child.stderr);
  let processExited = false;
  const exited = child.exited.then((code) => {
    processExited = true;
    return code;
  });
  void stdout.catch(() => undefined);
  void stderr.catch(() => undefined);
  void exited.catch(() => undefined);
  const allOutput = Promise.all([stdout, stderr, exited]);
  const waitLimit = runtime.cleanupTimeoutMs ?? cleanupTimeout;
  let outputSettled = false;
  try {
    const [stdoutText, stderrText, code] = await withDeadline(
      allOutput,
      runtime.buildTimeoutMs ?? buildTimeout,
      signal,
    );
    outputSettled = true;
    if (code !== 0)
      throw new Error(
        `Storybook build failed (${code}):\n${boundedText(stdoutText, buildOutputLimit)}\n${boundedText(stderrText, buildOutputLimit)}`,
      );
    // Keep the successful child output drained, but do not expose it unless a build fails.
    void stdoutText;
    void stderrText;
  } catch (primary) {
    if (outputSettled) throw primary;
    const cleanupFailures: string[] = [];
    if (!processExited) {
      try {
        child.kill();
      } catch (error) {
        cleanupFailures.push(`Storybook build termination request failed: ${errorMessage(error)}`);
      }
      const grace = Math.max(1, Math.min(150, Math.floor(waitLimit / 2)));
      const graceful = await bounded(exited, grace);
      if (graceful.state !== 'fulfilled') {
        try {
          child.kill(9);
        } catch (error) {
          cleanupFailures.push(`Storybook build force termination request failed: ${errorMessage(error)}`);
        }
      }
    }
    const [exit, stdoutState, stderrState] = await Promise.all([
      bounded(exited, waitLimit),
      bounded(stdout, waitLimit),
      bounded(stderr, waitLimit),
    ]);
    const unproved: string[] = [];
    for (const [label, result] of [
      ['Storybook build child', exit],
      ['Storybook build stdout', stdoutState],
      ['Storybook build stderr', stderrState],
    ] as const) {
      if (result.state === 'timeout') {
        cleanupFailures.push(`${label} did not settle within ${waitLimit}ms.`);
        unproved.push(label);
      } else if (result.state === 'rejected') {
        cleanupFailures.push(`${label} settlement failed: ${errorMessage(result.error)}`);
        unproved.push(label);
      }
    }
    throw new BuildSettlementFailure(primary, cleanupFailures, unproved);
  } finally {
    progress.buildFinished();
  }
}

class BuildSettlementFailure extends Error {
  constructor(
    readonly primary: unknown,
    readonly cleanupFailures: readonly string[],
    readonly unproved: readonly string[],
  ) {
    super(errorMessage(primary));
    this.name = 'BuildSettlementFailure';
  }
}

class CaptureLifetime {
  readonly signal = new AbortController();
  readonly resources: ResourceRegistry;
  readonly cleanupFailures: string[] = [];
  readonly unproved: string[] = [];
  private readonly cleanupIssues: CleanupIssue[] = [];
  private readonly scopes = new Set<ResourceRegistry>();
  private retired = false;
  private retirement: Promise<CleanupReport> | undefined;

  constructor(private readonly timeoutMs: number) {
    this.resources = new ResourceRegistry('Screenshot run', timeoutMs);
  }

  createScope(label: string): ResourceRegistry {
    if (this.retired) throw new Error(`Screenshot run is retired; cannot open ${label}.`);
    const scope = new ResourceRegistry(label, this.timeoutMs, () => !this.retired, this.signal.signal);
    this.scopes.add(scope);
    return scope;
  }

  async retireScope(scope: ResourceRegistry): Promise<void> {
    const report = await scope.retire('Capture batch retired.');
    this.scopes.delete(scope);
    this.absorb(report);
  }

  retire(reason = 'Screenshot run retired.'): Promise<CleanupReport> {
    if (this.retirement) return this.retirement;
    this.retired = true;
    this.signal.abort(new Error(reason));
    const reports = [this.resources.retire(reason), ...[...this.scopes].map((scope) => scope.retire(reason))];
    this.retirement = Promise.all(reports).then((values) => {
      values.forEach((report) => this.absorb(report));
      return { issues: [...this.cleanupIssues], unproved: [...this.unproved] };
    });
    return this.retirement;
  }

  private absorb(report: CleanupReport): void {
    for (const issue of report.issues) {
      if (this.cleanupIssues.some((seen) => seen.label === issue.label && seen.message === issue.message)) continue;
      this.cleanupIssues.push(issue);
      this.cleanupFailures.push(`${issue.label}: ${issue.message}`);
    }
    for (const reason of report.unproved) if (!this.unproved.includes(reason)) this.unproved.push(reason);
  }
}

/** Navigates to a story, retrying only a browser network-interface change once. */
export async function navigateStory(
  page: Pick<Page, 'goto'>,
  id: string,
  url: string,
  writeProgress: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  signal?: AbortSignal,
): ReturnType<Page['goto']> {
  const options = { waitUntil: 'load' as const, timeout: 60_000 };
  try {
    return await waitForRetirement(page.goto(url, options), signal);
  } catch (error) {
    if (signal?.aborted) throw abortedError(signal);
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('net::ERR_NETWORK_CHANGED')) throw error;
    writeProgress(`Retrying navigation for story ${id} after net::ERR_NETWORK_CHANGED.`);
    try {
      return await waitForRetirement(page.goto(url, options), signal);
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`Story ${id} navigation failed after retry: ${retryMessage}`, { cause: retryError });
    }
  }
}

/** Installed before preview code: Storybook's channel slot is assigned before it emits render events. */
function observeStorybook(): void {
  const preview = globalThis as StoryPreview;
  let channel: StoryPreview['__STORYBOOK_ADDONS_CHANNEL__'];
  let render: NonNullable<StoryPreview['__STORYBOOK_PREVIEW__']>['currentRender'];
  let signal: AbortSignal | undefined;
  let outcome: StoryOutcome | undefined;
  let finishing = false;
  let running = false;
  let cycle = 0;
  const errors: string[] = [];
  const rememberError = (message: string) => {
    if (errors.length < 20) errors.push(message.slice(0, 1_000));
  };
  const current = () => preview.__STORYBOOK_PREVIEW__?.currentRender;
  preview.__REZICS_STORY_OUTCOME__ = {
    read: () => {
      if (!render || current() !== render || render.abortController.signal !== signal) return undefined;
      if (signal?.aborted)
        return {
          storyId: render.id,
          renderId: render.renderId,
          cycle,
          phase: 'aborted',
          status: 'error',
          errors: [...errors],
        };
      if (render.phase !== outcome?.phase) return undefined;
      return outcome && { ...outcome, ...(errors.length ? { status: 'error' } : {}), errors: [...errors] };
    },
  };
  Object.defineProperty(preview, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get: () => channel,
    set: (next: typeof channel) => {
      if (!next || next === channel) {
        channel = next;
        return;
      }
      channel = next;
      next.on('storyRenderPhaseChanged', (event: { storyId: string; renderId: number; newPhase: string }) => {
        const active = current();
        if (
          !active ||
          active.id !== event.storyId ||
          active.renderId !== event.renderId ||
          active.phase !== event.newPhase
        )
          return;
        if (active !== render || active.abortController.signal !== signal || event.newPhase === 'loading') {
          // Concurrent cycles reuse renderId in Storybook. Their outcomes cannot be attributed safely.
          if (running) rememberError('Overlapping Storybook render cycles have no attributable outcome.');
          render = active;
          signal = active.abortController.signal;
          cycle += 1;
        }
        if (event.newPhase === 'loading') running = true;
        if (['finished', 'aborted', 'errored'].includes(event.newPhase)) running = false;
        outcome = { storyId: event.storyId, renderId: event.renderId, cycle, phase: event.newPhase, errors: [] };
        finishing = event.newPhase === 'finished';
        // STORY_FINISHED has no renderId; StoryRender emits it synchronously inside this finished phase.
        queueMicrotask(() => {
          finishing = false;
        });
      });
      next.on(
        'storyFinished',
        (event: {
          storyId: string;
          status: string;
          reporters: { type: string; status: string; result: unknown }[];
        }) => {
          if (
            !finishing ||
            !outcome ||
            event.storyId !== render?.id ||
            current() !== render ||
            signal !== render.abortController.signal ||
            signal.aborted
          )
            return;
          finishing = false;
          for (const report of event.reporters ?? []) {
            if (report.status === 'failed') {
              let detail: string | undefined;
              try {
                detail = JSON.stringify(report.result);
              } catch {
                detail = String(report.result);
              }
              rememberError(`${report.type}: ${detail}`);
            }
          }
          outcome.status = event.status === 'success' && errors.length === 0 ? 'success' : 'error';
        },
      );
      const recordError = (error: { message?: string; title?: string; description?: string }) => {
        if (current() === render)
          rememberError(error.message ?? [error.title, error.description].filter(Boolean).join(': '));
      };
      for (const event of ['playFunctionThrewException', 'storyThrewException', 'storyErrored'])
        next.on(event, recordError);
      next.on('unhandledErrorsWhilePlaying', (errors: Parameters<typeof recordError>[0][]) =>
        errors.forEach(recordError),
      );
      // Requests invalidate an earlier result even before Storybook starts the next render cycle.
      for (const event of ['updateStoryArgs', 'resetStoryArgs', 'updateGlobals', 'forceRemount', 'forceReRender']) {
        next.on(event, (data: { storyId?: string } = {}) => {
          if (!data.storyId || data.storyId === render?.id) {
            outcome = undefined;
            finishing = false;
          }
        });
      }
    },
  });
}

async function settle(
  page: Pick<Page, 'waitForFunction' | 'evaluate'>,
  id: string,
  pageErrors: readonly string[] = [],
  { timeout = 60_000, fonts = true } = {},
): Promise<StoryOutcome> {
  const clip = (value: string) => (value.length <= 1_000 ? value : `${value.slice(0, 1_000)}…`);
  const failure = (outcome: StoryOutcome | undefined, timeout?: unknown) => {
    const errors = [...(outcome?.errors ?? []), ...pageErrors].slice(0, 5).map(clip);
    const details = errors.length ? ` First page errors: ${errors.join(' | ')}` : '';
    const wait = timeout instanceof Error ? ` ${timeout.name}: ${timeout.message}` : '';
    return new Error(
      `Story ${id} did not finish rendering successfully (last phase: ${outcome?.phase ?? 'missing'}, outcome: ${outcome?.status ?? 'missing'}).${details}${wait}`,
    );
  };
  try {
    await page.waitForFunction(
      (storyId: string) => {
        const outcome = (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read();
        return (
          outcome?.storyId === storyId &&
          (outcome.status !== undefined || outcome.phase === 'errored' || outcome.phase === 'aborted')
        );
      },
      id,
      { timeout },
    );
  } catch (error) {
    const unavailable = (phase: string): StoryOutcome => ({ storyId: id, cycle: 0, phase, errors: [] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      page
        .evaluate(() => {
          const preview = globalThis as StoryPreview;
          const render = preview.__STORYBOOK_PREVIEW__?.currentRender;
          return (
            preview.__REZICS_STORY_OUTCOME__?.read() ??
            (render && {
              storyId: render.id,
              renderId: render.renderId,
              cycle: 0,
              phase: render.phase ?? 'missing',
              errors: [],
            })
          );
        })
        .catch(() => unavailable('unavailable')),
      new Promise<StoryOutcome>((resolve) => {
        timer = setTimeout(() => resolve(unavailable('unresponsive')), 1_000);
      }),
    ]).finally(() => clearTimeout(timer));
    throw failure(outcome, error);
  }
  const outcome = await page.evaluate(() => (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read());
  if (outcome?.storyId !== id || outcome.phase !== 'finished' || outcome.status !== 'success') throw failure(outcome);
  if (fonts) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (document.fonts.status !== 'loaded') await document.fonts.ready;
    });
  }
  return outcome;
}

async function prepareFullPageCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const overlay = document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    if (overlay) return;
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function captureOne(page: Page, origin: string, job: Job, out: string, signal?: AbortSignal): Promise<string> {
  const wait = <T>(operation: Promise<T>) => waitForRetirement(operation, signal);
  const clip = (value: string) => (value.length <= 1_000 ? value : `${value.slice(0, 1_000)}…`);
  const url = `${origin}/iframe.html?id=${encodeURIComponent(job.id)}&globals=locale:${job.locale};theme:${job.theme}`;
  const pageErrors: string[] = [];
  const appendPageError = (message: string) => {
    if (pageErrors.length < 50) pageErrors.push(clip(message));
  };
  const onPageError = (error: Error) => appendPageError(error.message);
  const onConsole = (message: import('playwright').ConsoleMessage) => {
    if (message.type() === 'error') appendPageError(message.text());
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  let navigated = false;
  try {
    await wait(navigateStory(page, job.id, url, undefined, signal));
    navigated = true;
    const outcome = await wait(settle(page, job.id, pageErrors));
    // Page route stories render their router asynchronously after Storybook finishes the story render.
    if (job.id.startsWith('pages-')) {
      try {
        await wait(page.locator('main:not([aria-busy="true"])').waitFor({ state: 'visible', timeout: 60_000 }));
      } catch (error) {
        const details = pageErrors.slice(0, 5);
        const firstErrors = details.length ? ` Page errors: ${details.join(' | ')}` : '';
        throw new Error(`Page story ${job.id} did not render its main content.${firstErrors} ${String(error)}`);
      }
    }
    await wait(prepareFullPageCapture(page));
    const latest = await wait(page.evaluate(() => (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read()));
    if (
      latest?.storyId !== job.id ||
      latest.renderId !== outcome.renderId ||
      latest.cycle !== outcome.cycle ||
      latest.status !== 'success' ||
      latest.phase !== 'finished'
    ) {
      throw new Error(`Story ${job.id} render outcome changed before capture. ${latest?.errors.join(' | ') ?? ''}`);
    }
    const file = join(out, screenshotFilename(job));
    await wait(page.screenshot({ path: file, type: 'png', fullPage: true, animations: 'disabled', scale: 'css' }));
    return file;
  } catch (error) {
    if (navigated && !signal?.aborted) {
      const diagnostic = join(out, screenshotFilename(job).replace(/\.png$/, '.diagnostic.png'));
      const retained = await wait(
        page.screenshot({
          path: diagnostic,
          type: 'png',
          fullPage: true,
          animations: 'disabled',
          scale: 'css',
          timeout: 5_000,
        }),
      ).then(
        () => true,
        () => false,
      );
      if (retained) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Diagnostic artifact (not a successful review): ${diagnostic}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
  }
}

async function captureJobs(
  jobs: readonly Job[],
  run: (job: Job, worker: number) => Promise<string>,
  workerCount = 1,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const files = new Array<string | undefined>(jobs.length);
  const failures: { index: number; value: CaptureFailure }[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(workerCount, jobs.length) }, (_, worker) =>
      (async () => {
        for (;;) {
          if (signal?.aborted) return;
          const index = cursor;
          cursor += 1;
          if (index >= jobs.length) return;
          const job = jobs[index];
          if (!job) return;
          if (signal?.aborted) return;
          try {
            files[index] = signal ? await waitForSignal(run(job, worker), signal) : await run(job, worker);
          } catch (error) {
            if (signal?.aborted) return;
            const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
            failures.push({
              index,
              value: {
                job,
                error: message.length <= 4_000 ? message : `${message.slice(0, 4_000)}…`,
              },
            });
          }
        }
      })(),
    ),
  );
  return {
    files: files.filter((file): file is string => file !== undefined),
    failures: failures.sort((left, right) => left.index - right.index).map(({ value }) => value),
  };
}

function reportCaptureResults(
  files: string[],
  failures: CaptureFailure[],
  write: (text: string) => void,
  unmatchedSelectors: readonly string[] = [],
): number {
  const clip = (value: string) => (value.length <= 4_000 ? value : `${value.slice(0, 4_000)}…`);
  for (const file of files) write(`${file}\n`);
  write(`${files.length}\n`);
  for (const { job, error } of failures) {
    const width = job.widthSuffix && job.width !== undefined ? ` ${job.width}px` : '';
    write(`${job.id} ${job.locale} ${job.theme}${width}: ${clip(error.replace(/\s+/g, ' ').trim())}\n`);
  }
  for (const selector of unmatchedSelectors) {
    write(`No stories matched --story ${JSON.stringify(selector)}.\n`);
  }
  return failures.length === 0 && unmatchedSelectors.length === 0 ? 0 : 1;
}

async function capture(
  browser: Browser,
  origin: string,
  jobs: readonly Job[],
  out: string,
  progress: ProgressReporter,
  lifetime: CaptureLifetime,
): Promise<CaptureResult> {
  let completed = 0;
  const files: string[] = [];
  const failures: CaptureFailure[] = [];
  const widths = [...new Set(jobs.map((job) => job.width ?? 1280))];
  for (const width of widths) {
    if (lifetime.signal.signal.aborted) throw abortedError(lifetime.signal.signal);
    const widthJobs = jobs.filter((job) => (job.width ?? 1280) === width);
    const scope = lifetime.createScope(`Capture contexts at ${width}px`);
    let primary: unknown;
    try {
      const contexts = await Promise.all(
        Array.from({ length: Math.min(captureLimit, widthJobs.length) }, (_, worker) =>
          scope.acquire(
            `context ${worker + 1} at ${width}px`,
            () =>
              browser.newContext({
                viewport: { width, height: viewportHeight },
                deviceScaleFactor: 1,
                reducedMotion: 'reduce',
              }),
            (context) => context.close(),
          ),
        ),
      );
      const pages = await Promise.all(
        contexts.map(async (context, worker) => {
          await waitForSignal(context.addInitScript(observeStorybook), lifetime.signal.signal);
          return scope.acquire(
            `page ${worker + 1} at ${width}px`,
            () => context.newPage(),
            (page) => page.close(),
          );
        }),
      );
      const result = await captureJobs(
        widthJobs,
        async (job, worker) => {
          const file = await scope.acquire(
            `capture job ${job.id} ${job.locale} ${job.theme} at ${width}px`,
            () => captureOne(pages[worker]!, origin, job, out, lifetime.signal.signal),
            () => undefined,
          );
          completed += 1;
          progress.captured(completed, jobs.length, file);
          return file;
        },
        pages.length,
        lifetime.signal.signal,
      );
      files.push(...result.files);
      failures.push(...result.failures);
    } catch (error) {
      primary = error;
    }
    await lifetime.retireScope(scope);
    if (primary !== undefined) throw primary;
    if (lifetime.signal.signal.aborted) throw abortedError(lifetime.signal.signal);
    if (lifetime.cleanupFailures.length) throw new Error(`Capture contexts at ${width}px could not be retired.`);
  }
  return { files, failures };
}

function workspaceRelative(path: string): string | undefined {
  const inside = relative(root, resolve(path));
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return inside.split(sep).join('/');
}

/** Keeps every flag, and rewrites `--out` to the workspace-relative directory a host can copy back. */
function screenshotCommand(argv: readonly string[], relativeOut: string | undefined): string[] {
  if (relativeOut === undefined) return ['bun', 'scripts/screenshots.ts', ...argv];
  const command = ['bun', 'scripts/screenshots.ts'];
  let outputSpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    command.push(argument);
    if (argument === '--out') {
      index += 1;
      command.push(relativeOut);
      outputSpecified = true;
    }
  }
  if (!outputSpecified) command.push('--out', relativeOut);
  return command;
}

const productionRuntime: ScreenshotRuntime = {
  serve,
  launch: () => chromium.launch(),
  async readStories(directory) {
    const indexFile = Bun.file(join(directory, 'index.json'));
    if (!(await indexFile.exists())) throw new Error('Storybook build did not write index.json.');
    const index = (await indexFile.json()) as { entries?: Record<string, { id?: string; type?: string }> };
    return Object.values(index.entries ?? {}).flatMap((entry) =>
      entry.type === 'story' && entry.id ? [entry.id] : [],
    );
  },
  mkdir,
  mkdtemp,
  rm,
  signals: {
    listen(signal, listener) {
      process.once(signal, listener);
      return () => process.removeListener(signal, listener);
    },
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Injected composition seam for lifetime acceptance; the CLI still enters through placeWebCheck. */
export async function runCaptureLifecycle(options: Options, runtime: ScreenshotRuntime): Promise<number> {
  await runtime.mkdir(join(root, '.temp'), { recursive: true });
  await runtime.mkdir(options.out, { recursive: true });
  const buildDir = await runtime.mkdtemp(join(root, '.temp/storybook-build-'));
  const site = join(buildDir, 'site');
  const timeoutMs = runtime.cleanupTimeoutMs ?? cleanupTimeout;
  const lifetime = new CaptureLifetime(timeoutMs);
  const writeStdout = runtime.stdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  const progress = runtime.progress?.(writeStderr) ?? createProgressReporter((line) => writeStderr(`${line}\n`));
  const detachSignals: (() => void)[] = [];
  const buildUnproved: string[] = [];
  const cleanupFailures: string[] = [];
  let primary: unknown;
  let result = 1;
  let signalExitCode: number | undefined;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    if (!runtime.signals) continue;
    detachSignals.push(
      runtime.signals.listen(signal, () => {
        signalExitCode = signal === 'SIGINT' ? 130 : 143;
        runtime.setExitCode?.(signalExitCode);
        void lifetime.retire(`Capture interrupted by ${signal}.`);
      }),
    );
  }
  try {
    await build(site, join(buildDir, 'cache'), progress, lifetime.signal.signal, runtime);
    if (lifetime.signal.signal.aborted) throw abortedError(lifetime.signal.signal);
    const availableStories = await waitForSignal(runtime.readStories(site), lifetime.signal.signal);
    const { stories, unmatchedSelectors } = selectStories(availableStories, options.stories);
    if (stories.length === 0 && unmatchedSelectors.length === 0) throw new Error('No stories matched.');
    if (stories.length === 0) {
      result = reportCaptureResults([], [], writeStdout, unmatchedSelectors);
    } else {
      const siteLease = await lifetime.resources.acquire(
        'temporary Storybook server',
        async () => runtime.serve(site),
        (site) => site.close(),
      );
      const browser = await lifetime.resources.acquire(
        'Playwright browser',
        () => runtime.launch(),
        (value) => value.close(),
      );
      if (lifetime.signal.signal.aborted) throw abortedError(lifetime.signal.signal);
      const origin = `http://127.0.0.1:${siteLease.port}`;
      const jobs = stories.flatMap((id) =>
        options.locales.flatMap((locale) =>
          options.themes.flatMap((theme) =>
            options.widths.map((width) => ({
              id,
              locale,
              theme,
              width,
              widthSuffix: options.widths.length > 1,
            })),
          ),
        ),
      );
      const { files, failures } = await capture(browser, origin, jobs, options.out, progress, lifetime);
      result = reportCaptureResults(files, failures, writeStdout, unmatchedSelectors);
    }
  } catch (error) {
    if (error instanceof BuildSettlementFailure) {
      primary = error.primary;
      cleanupFailures.push(...error.cleanupFailures);
      buildUnproved.push(...error.unproved);
    } else {
      primary = error;
    }
  }

  const resources = await lifetime.retire();
  cleanupFailures.push(...lifetime.cleanupFailures);
  buildUnproved.push(...resources.unproved);
  const reasons = [...new Set(buildUnproved)];
  let disposition: { path: string; state: 'retained' | 'unknown'; reasons: string[] } | undefined;
  if (reasons.length) {
    disposition = { path: buildDir, state: 'retained', reasons };
  } else {
    try {
      await runtime.rm(buildDir, { recursive: true, force: true });
    } catch (error) {
      const detail = `build directory removal failed: ${errorMessage(error)}`;
      cleanupFailures.push(detail);
      disposition = { path: buildDir, state: 'unknown', reasons: [detail] };
    }
  }
  for (const detach of detachSignals) detach();

  const uniqueCleanupFailures = [...new Set(cleanupFailures)];
  if (primary !== undefined || uniqueCleanupFailures.length || disposition) {
    throw new CaptureLifecycleFailure(primary, uniqueCleanupFailures, disposition, signalExitCode);
  }
  return result;
}

async function captureScreenshots(options: Options): Promise<number> {
  return runCaptureLifecycle(options, productionRuntime);
}

/** Operator captures stay local; worker captures retain workspace output and placement rules. */
export function screenshotExecution(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  inCheck?: () => boolean,
) {
  const entry = operatorEntry(argv, env, inCheck);
  const options = parseOptions(entry.args);
  const returned = workspaceRelative(options.out);
  if (!entry.operator && !options.help && returned === undefined)
    throw new Error('Web screenshots unavailable: --out must be inside the candidate workspace.');
  return { ...entry, options, returned };
}

/** Routes capture before building or starting a browser; unsupported destinations fail closed. */
export async function runScreenshots(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { operator, options, returned } = screenshotExecution(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (operator) return captureScreenshots(options);
  return placeWebCheck(
    {
      label: 'web screenshots',
      root,
      cwd: app,
      command: screenshotCommand(argv, returned),
      returns: [returned!],
    },
    async () => {
      return captureScreenshots(options);
    },
  );
}

if (import.meta.main) {
  runScreenshots()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = error instanceof CaptureLifecycleFailure && error.exitCode ? error.exitCode : 1;
    });
}
