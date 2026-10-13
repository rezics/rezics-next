import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { running, readResult } from './launch.ts';
import { engineOf, isCodex, type Ledger, type Task } from './types.ts';

export function termspacesTarget(): {socket: string; session: string} {
  return {socket:process.env.GOAL_TERMSPACES_SOCKET ?? `/tmp/tmux-${process.getuid?.()}/termspaces`,
    session:process.env.GOAL_TERMSPACES_SESSION ?? 'rezics-agents'};
}
export function windowTmux(args: string[]): string {
  const result = spawnSync('tmux',['-S',termspacesTarget().socket,...args],{encoding:'utf8'});
  if (result.status !== 0) throw new Error(`Goal windows unavailable: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
/** termspaces stores its stable session id in an option; the display name may differ. */
export function termspacesSession(): string | undefined {
  const result = spawnSync('tmux',['-S',termspacesTarget().socket,'list-sessions','-F',
    '#{session_id}\t#{session_name}\t#{@ts-session-id}'],{encoding:'utf8'});
  if (result.status !== 0) return undefined;
  const wanted = termspacesTarget().session;
  return result.stdout.split('\n').map(line=>line.split('\t'))
    .find(([,name,id])=>id === wanted || name === wanted)?.[0];
}
export function ensureTermspacesSession(): string {
  let session = termspacesSession();
  if (!session) {
    spawnSync('termspaces',['--socket-path',termspacesTarget().socket,'apply'],{encoding:'utf8',timeout:15_000});
    session = termspacesSession();
  }
  if (!session) throw new Error(missingTermspacesReason());
  return session;
}
export function missingTermspacesReason(): string {
  return `Goal windows unavailable: termspaces session ${termspacesTarget().session} missing on ${termspacesTarget().socket}; workers run unwatched, manager turns wait`;
}
export const workerWindowName = (task: Pick<Task,'id'|'goal'>): string => `goal-${task.goal ?? 'program'}-${task.id}`;
export interface WindowTurn {token: string; goal: string; n: number; phase: string; event_key: string | null;
  created_at: number; ended_at: number | null; code: number | null; ending: string | null; descriptor: string}
export const turnWindowName = (turn: Pick<WindowTurn,'goal'|'n'>): string => `goal-${turn.goal}-turn-${turn.n}`;
export function windowTurns(directory: string): WindowTurn[] {
  const file = join(directory,'coordinator.sqlite');
  if (!existsSync(file)) return [];
  const db = new Database(file,{readonly:true});
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return db.query(`SELECT a.*, (SELECT COUNT(*) FROM attempts b WHERE b.goal=a.goal AND b.rowid<=a.rowid) AS n
      FROM attempts a ORDER BY a.rowid`).all() as WindowTurn[];
  } finally { db.close(); }
}
export interface GoalWindow {id: string; name: string; attempt: string; turn: string; dead: boolean}
/** Filter on the name in tmux itself: other windows' contents and processes are never inspected. */
export function goalWindows(session: string): GoalWindow[] {
  return windowTmux(['list-windows','-t',session,'-f','#{m:goal-*,#{window_name}}','-F',
    '#{window_id}\t#{window_name}\t#{@goal-worker-attempt}\t#{@goal-turn-token}\t#{pane_dead}']).split('\n').filter(Boolean).map(line=>{
    const [id,name,attempt,turn,dead] = line.split('\t'); return {id:id!,name:name!,attempt:attempt!,turn:turn!,dead:dead === '1'};
  });
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function newGoalWindow(session: string, name: string, argv: string[], cwd?: string): string {
  return windowTmux(['new-window','-d','-P','-F','#{window_id}','-t',`${session}:`,'-n',name,
    ...cwd ? ['-c',cwd] : [],argv.map(quote).join(' ')]);
}
export function reconcileWindows(directory: string, ledger: Ledger, remove = false): {
  made: string[]; removed: string[]; error?: string;
} {
  const report: {made:string[];removed:string[];error?:string} = {made:[],removed:[]};
  try {
    // Removing windows is also useful when the configured session has already disappeared.
    const session = remove ? termspacesSession() : ensureTermspacesSession();
    if (!session) return report;
    const desired = new Map<string,{args:string[];cwd?:string;create:boolean;attempt?:string}>();
    if (!remove) {
      for (const task of Object.values(ledger.tasks).filter(running)) desired.set(workerWindowName(task),
        {args:['worker',directory,task.id],cwd:task.worktree,create:true,attempt:String(task.attempts.at(-1)!.n)});
      for (const turn of windowTurns(directory).filter(turn=>turn.phase !== 'done')) {
        desired.set(turnWindowName(turn),{args:['turn',directory,turn.token],create:turn.phase !== 'intent'});
      }
    }
    const existing = new Set<string>();
    for (const window of goalWindows(session)) {
      const view = desired.get(window.name);
      if (!view || existing.has(window.name) || (view.attempt && (window.attempt !== view.attempt || window.dead))) {
        windowTmux(['kill-window','-t',window.id]); report.removed.push(window.name);
      } else existing.add(window.name);
    }
    for (const [name,view] of desired) {
      if (!existing.has(name) && view.create) {
        const id = newGoalWindow(session,name,[process.execPath,import.meta.filename,...view.args],view.cwd);
        if (view.attempt) windowTmux(['set-option','-w','-t',id,'@goal-worker-attempt',view.attempt]);
        report.made.push(name);
      }
    }
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  return report;
}

function compact(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120); }
export function stepLine(record: unknown, fallbackTime: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const event = record as {type?:string;timestamp?:string;item?:Record<string,unknown>;message?:{content?:unknown};
    result?:string;text?:string;error?:{message?:string}};
  if (!event.type && !event.result && !event.text) return undefined;
  const item = event.item;
  let detail = event.result ?? event.text ?? event.error?.message;
  if (item) detail = [item.command,item.text,item.server,item.tool,item.aggregated_output]
    .filter(value=>typeof value === 'string').join(' ');
  if (!detail && event.message?.content) {
    const content = event.message.content;
    detail = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(block=>block.text ?? block.name ?? '').join(' ') : '';
  }
  return `${event.timestamp ?? fallbackTime} ${compact(`${event.type ?? 'result'}${item?.type ? ` ${String(item.type)}` : ''}${detail ? `: ${detail}` : ''}`)}`;
}
/** Reads only appended bytes; retain an incomplete JSON record until its newline arrives. */
export class StepStream {
  private offset = 0;
  private pending = '';
  private decoder = new TextDecoder();
  constructor(private readonly path: string, private readonly startedAt: string) {}
  read(final = false): string[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) { this.offset = 0; this.pending = ''; this.decoder = new TextDecoder(); }
    const fd = openSync(this.path,'r');
    try {
      const bytes = Buffer.alloc(size-this.offset);
      const count = readSync(fd,bytes,0,bytes.length,this.offset);
      this.offset += count;
      this.pending += this.decoder.decode(bytes.subarray(0,count),{stream:!final});
    } finally { closeSync(fd); }
    const records = this.pending.split('\n');
    this.pending = final ? '' : records.pop()!;
    return records.flatMap(line=>{
      try { const formatted = stepLine(JSON.parse(line),this.startedAt); return formatted ? [formatted] : []; }
      catch { return []; }
    });
  }
}
function ledgerAt(directory: string): Ledger {
  return JSON.parse(readFileSync(join(directory,'ledger.json'),'utf8')) as Ledger;
}
export async function followWorker(directory: string, id: string, print: (line:string)=>void = console.log,
  interval = 500): Promise<void> {
  const streams = new Map<number,StepStream>();
  const ended = new Set<number>();
  do {
    const task = ledgerAt(directory).tasks[id];
    if (!task) throw new Error(`Unknown task: ${id}`);
    const live = running(task);
    for (const attempt of task.attempts) {
      if (ended.has(attempt.n)) continue;
      let stream = streams.get(attempt.n);
      if (!stream) {
        print(`${attempt.startedAt} attempt ${attempt.n} ${engineOf(attempt)}/${attempt.effort}`);
        if (!isCodex(engineOf(attempt))) print(`${attempt.startedAt} deciding ${task.title} (engine reports at end)`);
        stream = new StepStream(attempt.output,attempt.startedAt); streams.set(attempt.n,stream);
      }
      const finished = !!attempt.endedAt || attempt !== task.attempts.at(-1) || !live;
      for (const line of stream.read(finished)) print(line);
      if (finished) {
        const result = readResult(attempt).text;
        const handoff = result.match(/^RESULT:.*$/m)?.[0] ?? result;
        print(`${attempt.endedAt ?? attempt.startedAt} ${compact(handoff)}`);
        ended.add(attempt.n);
      }
    }
    // Window followers remain for the next attempt until reconciliation removes their view.
    if (!live) return;
    await Bun.sleep(interval);
  } while (true);
}
export async function followTurn(directory: string, token: string, print: (line:string)=>void = console.log,
  interval = 500): Promise<void> {
  const initial = windowTurns(directory).find(turn=>turn.token === token);
  if (!initial) throw new Error('Unknown manager turn');
  print(`${new Date(initial.created_at).toISOString()} deciding ${compact(initial.event_key ?? 'manager event')}`);
  const stream = new StepStream(join(directory,'manager-runs',token,'output.jsonl'),new Date(initial.created_at).toISOString());
  do {
    const turn = windowTurns(directory).find(turn=>turn.token === token);
    if (!turn) return;
    for (const line of stream.read(turn.phase === 'done')) print(line);
    if (turn.phase === 'done') {
      const last = join(directory,'manager-runs',token,'last.md');
      if (existsSync(last)) print(`${new Date(turn.ended_at ?? turn.created_at).toISOString()} result: ${compact(readFileSync(last,'utf8'))}`);
      print(`${new Date(turn.ended_at ?? turn.created_at).toISOString()} turn ${turn.ending} code ${turn.code}`);
      return;
    }
    await Bun.sleep(interval);
  } while (true);
}
if (import.meta.main) {
  const [kind,directory,id] = process.argv.slice(2);
  if (!directory || !id) throw new Error('Window follower needs directory and task/turn');
  if (kind === 'worker') await followWorker(directory,id);
  else if (kind === 'turn') await followTurn(directory,id);
  else throw new Error('Unknown window follower');
}
