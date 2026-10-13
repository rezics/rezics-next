import { afterAll, onTestFinished, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AnswerRecordValidator, answerPersonas, answerRecord,
  type AnswerContract, type AnswerRecord, type AnswerSample } from '../../../scripts/api/answer-record.ts';
import type { PersonaSession } from './personas.ts';
import {
  outcomeTitle,
  type Persona,
  type RowOutcomes,
} from '../../../scripts/qa/cases/outcome-cells.ts';

/** A background read gets 45 seconds by default, repeating only its public refusal. */
export async function outcomeResponse(
  request: (signal: AbortSignal) => Promise<Response>,
  deadlineMs = 45_000,
): Promise<Response> {
  const signal = AbortSignal.timeout(deadlineMs);
  for (;;) {
    const response = await request(signal);
    if (response.status !== 503) return response;
    const problem = await response.clone().json() as { code?: string };
    if (problem.code !== 'work_read_unavailable' || signal.aborted) return response;
    await response.body?.cancel();
  }
}

export function outcomeTest(
  declaration: RowOutcomes,
  persona: Persona,
  fn: Parameters<typeof test>[1],
  recorder?: OutcomeRecorder,
): void {
  const title = outcomeTitle(declaration, persona);
  const cell = declaration.cells[persona]!;
  if (cell.state === 'pending') test.failing(title, fn);
  else if (recorder) test(title, () => {
    onTestFinished(() => recorder.finish(persona));
    return recorder.prove(persona, fn as () => unknown);
  });
  else test(title, fn);
}

/** Opt in with OUTCOME_RECORD_DIR=.temp/<directory>. Normal proofs do not load a contract or write. */
export class OutcomeRecorder {
  private readonly passed = new Set<Persona>();
  private failed = false;
  private published = false;
  private readonly samples = Object.fromEntries(answerPersonas.map(persona => [persona, []])) as AnswerRecord['personas'];
  private readonly directory?: string;
  private readonly root: string;
  private contract?: Promise<AnswerRecordValidator>;

  constructor(private readonly declaration: RowOutcomes, options: {
    directory?: string; root?: string; contract?: AnswerContract;
  } = {}) {
    this.root = options.root ?? process.cwd();
    const directory = options.directory ?? process.env.OUTCOME_RECORD_DIR;
    if (!directory) return;
    this.directory = recordingDirectory(this.root, directory);
    if (options.contract) this.contract = Promise.resolve(new AnswerRecordValidator(options.contract));
  }

  private validator(): Promise<AnswerRecordValidator> {
    return this.contract ??= import('../../../scripts/api/generate.ts').then(async ({ buildMainOpenApi }) =>
      new AnswerRecordValidator(JSON.parse(await buildMainOpenApi()) as AnswerContract));
  }

  /** Wrap the session's call, never its credential handling or fixture setup. */
  session(persona: Persona, session: Pick<PersonaSession, 'main'>) {
    return async (label: string, ...args: Parameters<PersonaSession['main']>): Promise<Response> => {
      const response = await session.main(...args);
      if (!this.directory) return response;
      try {
        if (this.passed.has(persona) || this.published) throw new Error('Samples must belong to an active persona proof');
        const [method, path, body] = args;
        const raw = await response.clone().text();
        const sample: AnswerSample = {
          label, operationId: (await this.validator()).operationId(method, path), method, path,
          ...(body === undefined ? {} : { body }), status: response.status,
          answer: raw ? JSON.parse(raw) as unknown : null,
          headers: Object.fromEntries(response.headers.entries()),
        };
        this.samples[persona].push(sample);
      } catch (error) { this.failed = true; throw error; }
      return response;
    };
  }

  async prove(persona: Persona, fn: () => unknown): Promise<void> {
    try {
      if (this.passed.has(persona)) throw new Error('A persona proof may run only once per record');
      await fn();
      this.passed.add(persona);
    } catch (error) { this.failed = true; throw error; }
  }

  /** A runner timeout can finish a test before its promise settles. */
  finish(persona: Persona): void {
    if (!this.passed.has(persona)) this.failed = true;
  }

  /** Call after the file's proofs; validation finishes before the one exclusive write. */
  async publish(): Promise<void> {
    if (!this.directory || this.published || this.failed || this.passed.size !== answerPersonas.length) return;
    if (answerPersonas.some(persona => this.declaration.cells[persona]?.state !== 'proved'))
      throw new Error('Recording needs six proved persona outcomes');
    const record = answerRecord(this.declaration.rowId, this.samples);
    const validator = await this.validator();
    validator.validate(record);
    // Recheck the directory after the run in case an ancestor became a symlink.
    const directory = recordingDirectory(this.root, this.directory);
    const file = resolve(directory, `${record.row}.json`);
    recordingDirectory(this.root, dirname(file));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    this.published = true;
  }
}

export function outcomeRecorder(declaration: RowOutcomes): OutcomeRecorder {
  const recorder = new OutcomeRecorder(declaration);
  afterAll(() => recorder.publish());
  return recorder;
}

function recordingDirectory(root: string, directory: string): string {
  const temp = resolve(root, '.temp');
  const target = resolve(root, directory);
  const inside = (path: string) => {
    const local = relative(temp, path);
    return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  };
  if (!inside(target)) throw new Error('OUTCOME_RECORD_DIR must name a directory under .temp/');
  let ancestor = target;
  while (!existsSync(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('OUTCOME_RECORD_DIR must stay under .temp/ without symlink escapes');
    ancestor = dirname(ancestor);
  }
  if (ancestor !== root && ancestor !== temp && !inside(realpathSync(ancestor)))
    throw new Error('OUTCOME_RECORD_DIR must stay under .temp/ without symlink escapes');
  if (existsSync(temp) && realpathSync(temp) !== temp)
    throw new Error('OUTCOME_RECORD_DIR must stay under .temp/ without symlink escapes');
  return target;
}
