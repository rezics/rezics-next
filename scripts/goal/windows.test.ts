import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoalCoordinator, TmuxLauncher, processIdentity, WAKE_PROMPT, WAKE_LAST_MESSAGE, type LaunchDescriptor } from './coordinator.ts';
import { followWorker, followTurn, goalWindows, reconcileWindows, StepStream, termspacesSession, turnWindowName, windowTurns, workerWindowName } from './windows.ts';
import type { Ledger, Task } from './types.ts';

function fixture() {
  const base = join(import.meta.dir,'../../.temp/window-tests'); mkdirSync(base,{recursive:true});
  const directory = mkdtempSync(join(base,'case-'));
  const socketDirectory = mkdtempSync('/tmp/goal-window-');
  const socket = join(socketDirectory,'s');
  const prior = {...process.env};
  const bin = join(directory,'bin'); mkdirSync(bin);
  process.env.GOAL_TERMSPACES_SOCKET = socket;
  process.env.GOAL_TERMSPACES_SESSION = 'test-agents';
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const applyLog = join(directory,'apply.log');
  writeFileSync(join(bin,'termspaces'),`#!/bin/sh\nprintf 'apply\\n' >> '${applyLog}'\n`); chmodSync(join(bin,'termspaces'),0o755);
  const tmux = (args:string[]) => {
    const result = spawnSync('tmux',['-S',socket,...args],{encoding:'utf8'});
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  tmux(['new-session','-d','-s','Agents display name','-n','maintainer','sleep 300']);
  tmux(['set-option','-t','Agents display name','@ts-session-id','test-agents']);
  tmux(['set-option','-t','Agents display name','remain-on-exit','on']);
  const children: ChildProcess[] = [];
  const script = join(bin,'codex');
  writeFileSync(script,`#!/bin/sh\nwhile :; do sleep 1; done\n`); chmodSync(script,0o755);
  function worker(id:string): Task {
    const child = spawn(script,[],{stdio:'ignore',detached:true}); children.push(child);
    return {id,goal:'program',title:'Complete the change',state:'running',engine:'codex',effort:'high',
      cases:[],paths:[],migrations:[],shared:[],depends:[],brief:'unused',worktree:directory,branch:'unused',base:'unused',
      attempts:[{n:1,pid:child.pid!,session:'worker-session',engine:'codex',effort:'high',
        output:join(directory,`${id}.json`),lastMessage:join(directory,`${id}.last.md`),startedAt:'2026-10-13T01:02:03Z'}]};
  }
  const ledger: Ledger = {tasks:{}};
  function save() { writeFileSync(join(directory,'ledger.json'),JSON.stringify(ledger)); }
  save();
  const descriptor: LaunchDescriptor = {goal:'program',generation:'role',session:'session',engine:'codex',effort:'high',
    cwd:directory,home:directory,program:process.execPath,args:['-e','await Bun.sleep(1000)',WAKE_PROMPT,WAKE_LAST_MESSAGE],
    env:{PATH:process.env.PATH!},socket,server:processIdentity(process.pid)!,
    previousOwner:{...processIdentity(process.pid)!,start:'gone'}};
  const coordinator = new GoalCoordinator({stateDir:directory,events:()=>[],admit:()=>{},owner:()=>undefined,
    launcher:{verify(){},live(){return true;},launch(){}}});
  coordinator.enroll(descriptor);
  function turn() {
    const token = crypto.randomUUID();
    coordinator.db.query(`INSERT INTO attempts(token,goal,generation,phase,descriptor,prompt,created_at,event_key)
      VALUES(?,?,?,'claimed',?,?,?,?)`).run(token,'program','role',JSON.stringify(descriptor),'Decide',Date.now(),'exit:worker');
    return windowTurns(directory).find(turn=>turn.token === token)!;
  }
  return {directory,socket,tmux,ledger,worker,save,turn,coordinator,descriptor,applyLog,
    cleanup() {
      coordinator.close();
      for (const child of children) { try { process.kill(-child.pid!,'SIGKILL'); } catch {} }
      spawnSync('tmux',['-S',socket,'kill-server'],{stdio:'ignore'});
      process.env = prior;
      rmSync(directory,{recursive:true,force:true}); rmSync(socketDirectory,{recursive:true,force:true});
    }};
}

describe('Goal windows are a ledger view', () => {
  test('two workers and a turn appear once, disappear on completion, and leave the maintainer alone', async () => {
    const f = fixture();
    try {
      const one = f.worker('G-10'), two = f.worker('G-11');
      f.ledger.tasks = {[one.id]:one,[two.id]:two}; f.save();
      const turn = f.turn();
      const session = termspacesSession()!;
      const untouched = f.tmux(['list-windows','-t',session,'-F','#{window_id}\t#{window_name}']);
      const first = reconcileWindows(f.directory,f.ledger);
      expect(first.error).toBeUndefined();
      expect(first.made).toEqual([workerWindowName(one),workerWindowName(two),turnWindowName(turn)]);
      // Give the followers enough time to start, then prove the next pass leaves their ids unchanged.
      await Bun.sleep(100);
      const ids = goalWindows(session).map(window=>window.id);
      expect(reconcileWindows(f.directory,f.ledger)).toEqual({made:[],removed:[]});
      expect(goalWindows(session).map(window=>window.id)).toEqual(ids);
      one.state = 'exited'; f.save();
      expect(reconcileWindows(f.directory,f.ledger).removed).toEqual([workerWindowName(one)]);
      two.state = 'stopped'; f.save();
      f.coordinator.db.query("UPDATE attempts SET phase='done' WHERE token=?").run(turn.token);
      expect(reconcileWindows(f.directory,f.ledger).removed).toEqual([workerWindowName(two),turnWindowName(turn)]);
      expect(f.tmux(['list-windows','-t',session,'-F','#{window_id}\t#{window_name}'])).toBe(untouched);
    } finally { f.cleanup(); }
  });
  test('a new attempt replaces a finished view; closing that view leaves the worker alive', () => {
    const f = fixture();
    try {
      const task = f.worker('G-10'); f.ledger.tasks[task.id] = task; f.save();
      reconcileWindows(f.directory,f.ledger);
      const original = goalWindows(termspacesSession()!)[0]!;
      const next = f.worker('G-11').attempts[0]!; next.n = 2;
      task.attempts[0]!.endedAt = '2026-10-13T02:00:00Z'; task.attempts.push(next); f.save();
      const report = reconcileWindows(f.directory,f.ledger);
      expect(report.removed).toEqual([workerWindowName(task)]);
      expect(report.made).toEqual([workerWindowName(task)]);
      const view = goalWindows(termspacesSession()!)[0]!;
      expect(view.id).not.toBe(original.id);
      f.tmux(['kill-window','-t',view.id]);
      expect(processIdentity(next.pid)).toBeDefined();
      expect(reconcileWindows(f.directory,f.ledger).made).toEqual([workerWindowName(task)]);
    } finally { f.cleanup(); }
  });
  test('--remove removes every Goal window and preserves other windows', () => {
    const f = fixture();
    try {
      const session = termspacesSession()!;
      for (const name of ['goal-orphan-G-99','goal-program-turn-7']) f.tmux(['new-window','-d','-t',`${session}:`,'-n',name,'sleep 300']);
      expect(reconcileWindows(f.directory,f.ledger,true).removed).toEqual(['goal-orphan-G-99','goal-program-turn-7']);
      expect(goalWindows(session)).toEqual([]);
      expect(f.tmux(['list-windows','-t',session,'-F','#{window_name}'])).toBe('maintainer');
    } finally { f.cleanup(); }
  });
  test('a missing session calls apply once and leaves workers running; apply can recover the display name', () => {
    const f = fixture();
    try {
      const task = f.worker('G-10'); f.ledger.tasks[task.id] = task; f.save();
      f.tmux(['kill-session','-t',termspacesSession()!]);
      expect(reconcileWindows(f.directory,f.ledger).error).toContain('workers run unwatched, manager turns wait');
      expect(readFileSync(f.applyLog,'utf8')).toBe('apply\n');
      expect(processIdentity(task.attempts[0]!.pid)).toBeDefined();
      const waiting = new GoalCoordinator({stateDir:f.directory,launcher:new TmuxLauncher(f.directory),
        events:()=>[{key:'mail:pending',body:'Decide'}],owner:()=>undefined,admit:()=>{}});
      try {
        waiting.step();
        const wake = waiting.status().wakes[0]!;
        expect(wake.error).toContain('manager turns wait');
        expect(wake.failures).toBe(1);
        expect(waiting.status().attempts).toEqual([]);
        waiting.step(); expect(waiting.status().wakes[0]!.failures).toBe(1);
        expect(readFileSync(f.applyLog,'utf8')).toBe('apply\n');
      } finally { waiting.close(); }
      writeFileSync(join(f.directory,'bin','termspaces'),`#!/bin/sh\nprintf 'apply\\n' >> '${f.applyLog}'\ntmux -S '${f.socket}' new-session -d -s 'test-agents' -n maintainer 'sleep 300'\n`);
      expect(reconcileWindows(f.directory,f.ledger).made).toEqual([workerWindowName(task)]);
      expect(readFileSync(f.applyLog,'utf8')).toBe('apply\napply\n');
    } finally { f.cleanup(); }
  });
  test('an intent reserves its window name without launching or changing the turn', () => {
    const f = fixture();
    try {
      const turn = f.turn(); f.coordinator.db.query("UPDATE attempts SET phase='intent' WHERE token=?").run(turn.token);
      expect(reconcileWindows(f.directory,f.ledger)).toEqual({made:[],removed:[]});
      expect(windowTurns(f.directory)[0]!.phase).toBe('intent');
    } finally { f.cleanup(); }
  });
});

describe('worker and turn followers', () => {
  test('recorded Codex attempts print each event, each attempt, and each handoff', async () => {
    const f = fixture();
    try {
      const task = f.worker('G-10'); task.state = 'exited';
      const first = task.attempts[0]!;
      writeFileSync(first.output,JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'task test -- file',aggregated_output:'ok'}})+'\n');
      writeFileSync(first.lastMessage!,'RESULT: partial\nNEXT: continue'); first.endedAt = '2026-10-13T01:03:00Z';
      const second = {...first,n:2,output:join(f.directory,'second.json'),lastMessage:join(f.directory,'second.last.md')};
      writeFileSync(second.output,JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done '+ 'x'.repeat(200)}})+'\n');
      writeFileSync(second.lastMessage!,'RESULT: done\nCASES: delivered'); task.attempts.push(second);
      f.ledger.tasks[task.id] = task; f.save();
      const lines:string[] = []; await followWorker(f.directory,task.id,line=>lines.push(line),1);
      expect(lines.filter(line=>line.includes(' attempt '))).toHaveLength(2);
      expect(lines.some(line=>line.includes('command_execution: task test -- file ok'))).toBe(true);
      expect(lines.filter(line=>line.includes('RESULT:'))).toEqual([
        '2026-10-13T01:03:00Z RESULT: partial','2026-10-13T01:03:00Z RESULT: done']);
      expect(lines.find(line=>line.includes('agent_message'))!.split('Z ')[1]!.length).toBe(120);
      const cli = spawnSync(process.execPath,[join(import.meta.dir,'goalctl.ts'),'follow',task.id],
        {encoding:'utf8',env:{...process.env,GOAL_MAIL_STATE_DIR:f.directory}});
      expect(cli.status,cli.stderr).toBe(0); expect(cli.stdout.trim().split('\n')).toEqual(lines);
    } finally { f.cleanup(); }
  });
  test('an engine with no stream says what it is deciding and prints its final result', async () => {
    const f = fixture();
    try {
      const task = f.worker('G-10'); task.state = 'exited'; task.attempts[0]!.engine = 'claude';
      writeFileSync(task.attempts[0]!.output,JSON.stringify({type:'result',result:'RESULT: done\nCASES: complete'}));
      f.ledger.tasks[task.id] = task; f.save();
      const lines:string[] = []; await followWorker(f.directory,task.id,line=>lines.push(line),1);
      expect(lines.some(line=>line.includes('deciding Complete the change (engine reports at end)'))).toBe(true);
      expect(lines.at(-1)).toEndWith('RESULT: done');
      const turn = f.turn();
      f.coordinator.db.query("UPDATE attempts SET phase='done',code=0,ending='exit',ended_at=? WHERE token=?").run(Date.now(),turn.token);
      const output = join(f.directory,'manager-runs',turn.token); mkdirSync(output,{recursive:true});
      writeFileSync(join(output,'output.jsonl'),JSON.stringify({type:'result',result:'Approved'}));
      const turnLines:string[] = []; await followTurn(f.directory,turn.token,line=>turnLines.push(line),1);
      expect(turnLines[0]).toContain('deciding exit:worker');
      expect(turnLines.some(line=>line.includes('result: Approved'))).toBe(true);
      expect(turnLines.at(-1)).toContain('turn exit code 0');
    } finally { f.cleanup(); }
  });
  test('an incomplete UTF-8 event is emitted once only when complete', () => {
    const f = fixture();
    try {
      const file = join(f.directory,'stream');
      const bytes = Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'中文'}})+'\n');
      const split = bytes.indexOf(Buffer.from('中'))+1;
      writeFileSync(file,bytes.subarray(0,split));
      const stream = new StepStream(file,'now'); expect(stream.read()).toEqual([]);
      appendFileSync(file,bytes.subarray(split)); expect(stream.read()).toEqual(['now item.completed agent_message: 中文']);
      expect(stream.read(true)).toEqual([]);
    } finally { f.cleanup(); }
  });
});
