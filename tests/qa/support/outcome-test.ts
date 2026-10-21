import { afterAll, afterEach, onTestFinished, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AnswerRecordValidator, answerPersonas, answerRecord,
  type AnswerContract, type AnswerRecord, type AnswerSample } from '../../../scripts/api/answer-record.ts';
import type { PersonaSession } from './personas.ts';
import { personaRequests } from './request-watch.ts';
import { duringPersonaProof } from './proof-phase.ts';
import { matchesAnswerContractDebt, type AnswerContractDebt } from './answer-contract-debts.ts';
import {
  outcomeTitle,
  type Persona,
  type RowOutcomes,
} from '../../../scripts/qa/cases/outcome-cells.ts';

// Only the runner imports this module; fixture preparation has no test lifecycle.
afterEach(() => personaRequests.reportPending());
afterAll(() => personaRequests.reportPending());

export { outcomeResponse } from './outcome-response.ts';

export function outcomeTest(
  declaration: RowOutcomes,
  persona: Persona,
  fn: Parameters<typeof test>[1],
  recorder?: OutcomeRecorder,
  options?: { pending?: 'assert' },
): void {
  const title = outcomeTitle(declaration, persona);
  const cell = declaration.cells[persona]!;
  const proof = recorder ? () => {
    onTestFinished(() => recorder.finish(persona));
    return recorder.prove(persona, fn as () => unknown);
  } : () => duringPersonaProof(fn as () => unknown, leave => onTestFinished(() => { leave(); }));
  if (cell.state === 'pending' && options?.pending !== 'assert') test.failing(title, proof);
  else test(title, proof);
}

let processValidator: Promise<AnswerRecordValidator> | undefined;
const suppliedValidators = new WeakMap<AnswerContract, AnswerRecordValidator>();

function answerValidator(contract?: AnswerContract): Promise<AnswerRecordValidator> {
  if (!contract) {
    // Generation is a separate repository gate. Reading its artifact avoids importing
    // the entire server into each proof process; compile only schemas actually sampled.
    return processValidator ??= readFile(new URL('../../../generated/openapi/main/public.json', import.meta.url), 'utf8')
      .then(source => new AnswerRecordValidator(JSON.parse(source) as AnswerContract));
  }
  let validator = suppliedValidators.get(contract);
  if (!validator) { validator = new AnswerRecordValidator(contract); suppliedValidators.set(contract, validator); }
  return Promise.resolve(validator);
}

/** Every sample is checked. Opt in to writing with OUTCOME_RECORD_DIR=.temp/<directory>. */
export class OutcomeRecorder {
  private readonly passed = new Set<Persona>();
  private readonly active = new Set<Persona>();
  private readonly proofFinishes = new Map<Persona, () => void>();
  private readonly sampleFailures = new Map<Persona, unknown>();
  private failed = false;
  private published = false;
  private readonly samples = Object.fromEntries(answerPersonas.map(persona => [persona, [] as AnswerSample[]])) as AnswerRecord['personas'];
  private readonly directory?: string;
  private readonly root: string;
  private readonly binarySources: readonly string[];

  constructor(private readonly declaration: RowOutcomes, options: {
    directory?: string; root?: string; contract?: AnswerContract; debts?: readonly AnswerContractDebt[];
    binarySources?: readonly string[];
  } = {}) {
    this.root = options.root ?? process.cwd();
    this.binarySources = options.binarySources ?? [];
    const directory = options.directory ?? process.env.OUTCOME_RECORD_DIR;
    if (directory) this.directory = recordingDirectory(this.root, directory);
    this.contract = options.contract;
    this.debts = options.debts;
  }

  private readonly contract?: AnswerContract;
  private readonly debts?: readonly AnswerContractDebt[];

  private validator(): Promise<AnswerRecordValidator> {
    return answerValidator(this.contract);
  }

  /** Load the contract in fixture setup, outside a persona's proof budget. */
  async prepare(): Promise<void> {
    await this.validator();
  }

  /** Wrap the session's call, never its credential handling or fixture setup. */
  session(persona: Persona, session: Pick<PersonaSession, 'main'>) {
    return async (label: string, ...args: Parameters<PersonaSession['main']>): Promise<Response> => {
      if (this.directory && !this.active.has(persona)) {
        this.failed = true;
        throw new Error('Samples must belong to an active persona proof');
      }
      const response = await session.main(...args);
      try {
        if (response.status >= 500) throw new Error(`Persona proof ${persona} received HTTP ${response.status}: ${await response.clone().text()}`);
        if (this.passed.has(persona) || this.published) throw new Error('Samples must belong to an active persona proof');
        const [method, path, body] = args;
        const validator = await this.validator();
        let operationId = '<undeclared>';
        try { operationId = validator.operationId(method, path); } catch { /* Report the full sample context below. */ }
        let answer: unknown = null;
        let binary: AnswerSample['binary'];
        const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (this.binarySources.length && response.ok && mediaType && !mediaType.endsWith('/json') && !mediaType.endsWith('+json')) {
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          for (const source of this.binarySources) {
            const file = resolve(this.root, source);
            if (isAbsolute(source) || relative(this.root, file).startsWith('..')
              || relative(realpathSync(this.root), realpathSync(file)).startsWith('..')) throw new Error('Binary source must stay inside the repository');
            const original = await readFile(file);
            if (original.byteLength === bytes.byteLength && createHash('sha256').update(original).digest('hex') === sha256) {
              binary = { source, byteLength: bytes.byteLength, sha256 }; break;
            }
          }
          if (!binary) throw new Error(`Binary answer ${label} has no matching registered source asset (${sha256})`);
        } else {
          const raw = await response.clone().text();
          try { if (raw) answer = JSON.parse(raw) as unknown; }
          catch { throw new Error(`row ${this.declaration.rowId}, persona ${persona}, sample ${label}, operation ${operationId}, `
            + `status ${response.status}, /answer: expected JSON, received string; Response is not valid JSON`); }
        }
        const sample: AnswerSample = {
          label, operationId, method, path,
          ...(body === undefined ? {} : { body }), status: response.status,
          answer,
          ...(binary ? { binary } : {}),
          headers: Object.fromEntries(response.headers.entries()),
        };
        const violations = validator.responseViolations(sample)
          .filter(violation => !matchesAnswerContractDebt(violation, this.debts));
        if (violations.length) throw new Error(violations.map(violation =>
          `row ${this.declaration.rowId}, persona ${persona}, sample ${label}, operation ${violation.operationId}, `
          + `status ${violation.status}, ${violation.path}: expected ${violation.expected}, received ${violation.received}; ${violation.message}`).join('\n'));
        if (this.directory) this.samples[persona].push(sample);
      } catch (error) { this.failed = true; this.sampleFailures.set(persona, error); throw error; }
      return response;
    };
  }

  async prove(persona: Persona, fn: () => unknown): Promise<void> {
    try {
      if (this.passed.has(persona) || this.active.has(persona)) throw new Error('A persona proof may run only once per record');
      this.active.add(persona);
      await duringPersonaProof(fn, leave => this.proofFinishes.set(persona, leave));
      if (this.sampleFailures.has(persona)) throw this.sampleFailures.get(persona);
      this.passed.add(persona);
    } catch (error) { this.failed = true; throw error; }
    finally { this.active.delete(persona); this.proofFinishes.delete(persona); }
  }

  /** A runner timeout can finish a test before its promise settles. */
  finish(persona: Persona): void {
    this.proofFinishes.get(persona)?.();
    if (!this.passed.has(persona)) this.failed = true;
    this.active.delete(persona);
  }

  /** Call after the file's proofs; validation finishes before the one exclusive write. */
  async publish(): Promise<void> {
    if (!this.directory || this.published || this.failed || this.passed.size !== answerPersonas.length) return;
    if (answerPersonas.some(persona => this.declaration.cells[persona]?.state !== 'proved'))
      throw new Error('Recording needs six proved persona outcomes');
    const record = answerRecord(this.declaration.rowId, this.samples);
    const validator = await this.validator();
    validator.validate(record, violation => matchesAnswerContractDebt(violation, this.debts));
    // Recheck the directory after the run in case an ancestor became a symlink.
    const directory = recordingDirectory(this.root, this.directory);
    const file = resolve(directory, `${record.row}.json`);
    recordingDirectory(this.root, dirname(file));
    mkdirSync(dirname(file), { recursive: true });
    const staged = resolve(dirname(file), `.answer-${randomUUID()}.json`);
    try {
      writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      // Linking a fully written file publishes atomically and refuses an existing destination.
      linkSync(staged, file);
    } finally { rmSync(staged, { force: true }); }
    this.published = true;
  }
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
