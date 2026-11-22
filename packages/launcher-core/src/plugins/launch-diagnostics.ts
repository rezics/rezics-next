import { launchDiagnosticsPlugin, type LaunchIssue, type LaunchReport } from '@rezics/launcher-contract';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { launchIssues, processLaunchIssue, safeLaunchFailure, visualNovelExecutableIssue } from '../launch-issues.ts';
import { credentialRedactor, redactDiagnosticCopy, redactLogText } from '../launch-redaction.ts';
import { fileInfo, Locks, readJson, writeJson } from '../storage.ts';
import { crashExcerptLimit, observeMinecraftCrashes } from './minecraft-crash-reports.ts';

const outputLimit = 65_536;
const outputDrainMs = 1_000;
type CrashObservation = Awaited<ReturnType<typeof observeMinecraftCrashes>>;

class Recording {
  private tail = '';
  private truncated = false;
  private state: LaunchReport['state'] = 'running';
  private exitCode: number | null = null;
  private signal: string | null = null;
  private error: string | undefined;
  private issue: LaunchIssue | undefined;
  private crashReport: LaunchReport['crashReport'];
  private userStopped = false;

  constructor(
    private readonly minecraft: boolean,
    private readonly startupIssue: LaunchIssue,
  ) {}

  view(): LaunchReport {
    return {
      state: this.state,
      output: this.tail,
      truncated: this.truncated,
      exitCode: this.exitCode,
      signal: this.signal,
      ...(this.error && { error: this.error }),
      ...(this.state === 'failed' && this.issue && { issue: this.issue }),
      ...(this.crashReport && { crashReport: this.crashReport }),
    };
  }

  private append(text: string) {
    const next = this.tail + text;
    this.truncated ||= next.length > outputLimit;
    this.tail = next.slice(-outputLimit);
  }

  private observeIssue(line: string) {
    const issue = processLaunchIssue(line);
    if (issue && (!this.issue || (issue.kind === 'memory' && this.issue.kind === 'java'))) this.issue = issue;
  }

  async captureCrash(observe: CrashObservation, accessToken?: string) {
    if (this.userStopped || !observe) return;
    const report = await observe(accessToken);
    if (!report) return;
    this.crashReport = report;
    for (const line of report.text.split('\n')) this.observeIssue(line);
    this.failIssue(this.issue ?? launchIssues.crash);
  }

  attach(child: ChildProcess, accessToken: string | undefined, done: () => void) {
    const streams = [child.stdout, child.stderr].filter((stream) => stream !== null);
    for (const stream of streams) {
      const redact = credentialRedactor(accessToken);
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let discardLine = false;

      const receive = (text: string, final = false) => {
        const segments = text.split('\n');
        const fragment = final ? '' : (segments.pop() ?? '');
        const complete: string[] = [];
        for (const segment of segments) {
          if (!discardLine && pending.length + segment.length <= outputLimit) {
            const line = redact(pending + segment);
            if (this.minecraft) this.observeIssue(line);
            complete.push(line + '\n');
          } else {
            this.truncated = true;
          }
          pending = '';
          discardLine = false;
        }
        if (pending.length + fragment.length > outputLimit) {
          pending = '';
          discardLine = true;
          this.truncated = true;
        } else if (!discardLine) {
          pending += fragment;
        }
        if (complete.length) this.append(complete.join(''));
      };

      stream.on('data', (chunk: Buffer) => receive(decoder.write(chunk)));
      const finish = () => {
        stream.removeListener('close', finish);
        stream.removeListener('end', finish);
        const last = decoder.end();
        if (last || pending || discardLine) receive(last, true);
      };
      stream.once('end', finish);
      stream.once('close', finish);
    }
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitCode = code;
      this.signal = signal;
      if (this.userStopped) {
        this.state = 'exited';
        this.error = undefined;
      } else if (this.state === 'running') this.state = code === 0 && signal === null ? 'exited' : 'failed';
    };
    let drain: ReturnType<typeof setTimeout> | undefined;
    child.once('error', () => this.failIssue(this.startupIssue));
    child.once('exit', (code, signal) => {
      ended(code, signal);
      // A game can leave another process holding the inherited output pipes.
      drain = setTimeout(() => {
        for (const stream of streams) {
          if (stream.readableEnded || stream.destroyed) continue;
          this.truncated = true;
          stream.destroy();
        }
      }, outputDrainMs);
    });
    child.once('close', (code, signal) => {
      clearTimeout(drain);
      ended(code, signal);
      done();
    });
  }

  fail(error: unknown) {
    this.failIssue(safeLaunchFailure(error).issue);
  }

  private failIssue(issue: LaunchIssue) {
    this.state = 'failed';
    this.issue = issue;
    this.error = issue.summary;
  }

  stopped() {
    this.userStopped = true;
  }
}

function storedReport(value?: LaunchReport): LaunchReport | null {
  if (!value || !['running', 'exited', 'failed'].includes(value.state) || typeof value.output !== 'string') return null;
  const output = redactLogText(value.output);
  const issue =
    value.issue &&
    Object.hasOwn(launchIssues, value.issue.kind) &&
    (value.issue.action === launchIssues[value.issue.kind].action ||
      (value.issue.kind === visualNovelExecutableIssue.kind &&
        value.issue.action === visualNovelExecutableIssue.action)) &&
    typeof value.issue.summary === 'string'
      ? {
          kind: value.issue.kind,
          action: value.issue.action,
          summary: redactLogText(value.issue.summary).slice(0, 320),
        }
      : undefined;
  const error = value.error ? (issue?.summary ?? launchIssues.unknown.summary) : undefined;
  const crash = value.state === 'failed' && typeof value.crashReport?.text === 'string' ? value.crashReport : undefined;
  const crashText = crash ? redactLogText(crash.text) : '';
  return {
    state: value.state,
    output: output.slice(-outputLimit),
    truncated: value.truncated === true || output.length > outputLimit,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signal: value.signal && /^SIG[A-Z\d]{1,16}$/u.test(value.signal) ? value.signal : null,
    ...(error && { error }),
    ...(issue && { issue }),
    ...(crashText && {
      crashReport: {
        text: crashText.slice(0, crashExcerptLimit),
        truncated: crash?.truncated === true || crashText.length > crashExcerptLimit,
      },
    }),
  };
}

class GameLogs {
  private readonly live = new Map<string, Recording>();
  private readonly writes = new Locks();
  private readonly observers = new Set<(instanceId: string) => void>();

  constructor(private readonly directory: (instanceId: string) => string) {}

  subscribe(observer: (instanceId: string) => void) {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private publish(id: string) {
    for (const observe of this.observers) {
      try {
        observe(id);
      } catch {
        // The launch and its report outlive any observer.
      }
    }
  }

  private path(id: string) {
    return join(this.directory(id), 'last-launch.json');
  }

  async read(id: string): Promise<LaunchReport | null> {
    const live = this.live.get(id);
    if (live) return live.view();
    const path = this.path(id);
    try {
      const info = await fileInfo(path);
      if (!info?.isFile() || info.size > 524_288) return null;
      return storedReport(await readJson<LaunchReport>(path));
    } catch {
      throw new Error('The saved launch report could not be read.');
    }
  }

  async copy(id: string, paths: readonly string[]) {
    const report = await this.read(id);
    if (!report) return null;
    const lines = [
      'REZICS Launcher diagnosis',
      `Status ${report.state}`,
      ...(report.exitCode !== null ? [`Exit code ${report.exitCode}`] : []),
      ...(report.signal ? [`Signal ${report.signal}`] : []),
      ...(report.issue?.summary || report.error ? [report.issue?.summary ?? report.error!] : []),
    ];
    const summary = redactDiagnosticCopy(lines.join('\n'), paths);
    const crashText = report.crashReport && redactDiagnosticCopy(report.crashReport.text, paths).trimEnd();
    const crashTruncated = report.crashReport?.truncated || (crashText?.length ?? 0) > crashExcerptLimit;
    const crash = crashText
      ? `\n\nMinecraft crash report${crashTruncated ? ' (excerpt)' : ''}\n${crashText.slice(0, crashExcerptLimit)}`
      : '';
    const output = redactDiagnosticCopy(report.output, paths).trimEnd();
    const heading = '\n\nRecent output';
    const full = summary + crash + heading + '\n' + output;
    if (!report.truncated && full.length <= outputLimit) return full;
    const prefix = summary + crash + heading + ' (truncated)\n';
    return prefix + output.slice(-(outputLimit - prefix.length));
  }

  begin(id: string, minecraft: boolean, startupIssue: LaunchIssue) {
    const recording = new Recording(minecraft, startupIssue);
    let observeCrashes: CrashObservation;
    this.live.set(id, recording);
    const persist = () =>
      this.writes.run(id, async () => {
        if (this.live.get(id) !== recording) return;
        let saved = false;
        try {
          await writeJson(this.path(id), recording.view());
          saved = true;
        } finally {
          if (this.live.get(id) === recording) {
            if (saved) this.live.delete(id);
            this.publish(id);
          }
        }
      });
    return {
      async prepareMinecraftCrashReports(game: string) {
        observeCrashes = await observeMinecraftCrashes(game);
      },
      watch(child: ChildProcess, secret?: string) {
        return new Promise<void>((resolve) => {
          recording.attach(child, secret, () => {
            // Storage failure leaves the current report readable in this Launcher session.
            void recording
              .captureCrash(observeCrashes, secret)
              .catch(() => undefined)
              .then(persist)
              .then(resolve, resolve);
          });
        });
      },
      fail(error: unknown) {
        recording.fail(error);
        return persist();
      },
      stopped() {
        recording.stopped();
      },
    };
  }
}

/** The bundled backend receives an instance storage port and the process it can observe. */
export function createLaunchDiagnostics(directory: (instanceId: string) => string) {
  const logs = new GameLogs(directory);
  return {
    manifest: launchDiagnosticsPlugin,
    begin: (
      id: string,
      minecraft = false,
      startupIssue: LaunchIssue = minecraft ? launchIssues.java : launchIssues.executable,
    ) => logs.begin(id, minecraft, startupIssue),
    subscribe: (observer: (instanceId: string) => void) => logs.subscribe(observer),
    read: (id: string) => logs.read(id),
    copy: (id: string, paths: readonly string[]) => logs.copy(id, paths),
  };
}
