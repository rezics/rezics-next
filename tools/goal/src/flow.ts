import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';
import type { Task } from './types.ts';

export const FLOW_STAGES = ['dispatch', 'start', 'check', 'worker', 'landing', 'dev-update', 'verification', 'integration', 'promotion'] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];
export type FlowEvent = { taskId: string; attempt: number; stage: FlowStage; action: string; at: string; detail?: string };
export const flowMigrations = [{ module: 'flow', version: 1, sql: `CREATE TABLE flow_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, stage TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, detail TEXT); CREATE INDEX flow_events_task ON flow_events(task_id, attempt, sequence); CREATE TABLE flow_alarm_sends (threshold TEXT PRIMARY KEY, sent_at TEXT NOT NULL); CREATE TABLE flow_audit_runs (day TEXT PRIMARY KEY, task_id TEXT NOT NULL);` }];
export function ensureFlow(db: Database): void { migrate(db, flowMigrations); }
export function recordFlow(db: Database, event: FlowEvent): void {
  ensureFlow(db);
  db.query('INSERT INTO flow_events(task_id,attempt,stage,action,at,detail) VALUES (?,?,?,?,?,?)').run(event.taskId, event.attempt, event.stage, event.action, event.at, event.detail ?? null);
}
export function readFlow(db: Database, since = '0000-01-01T00:00:00.000Z'): FlowEvent[] {
  ensureFlow(db);
  return (db.query('SELECT task_id,attempt,stage,action,at,detail FROM flow_events WHERE at >= ? ORDER BY at,sequence').all(since) as any[]).map(r => ({taskId:r.task_id,attempt:r.attempt,stage:r.stage,action:r.action,at:r.at,...(r.detail === null ? {} : {detail:r.detail})}));
}
const percentile = (values: number[], p: number): number => values.length ? values[Math.ceil(p * values.length) - 1]! : 0;
export function flowReport(events: FlowEvent[], tasks: Task[], now = Date.now()) {
  const ordered = [...events].sort((a,b) => a.at.localeCompare(b.at));
  const byTask = new Map<string, FlowEvent[]>();
  for (const event of ordered) byTask.set(event.taskId, [...(byTask.get(event.taskId) ?? []), event]);
  const durations: Record<string, number[]> = Object.fromEntries(FLOW_STAGES.map(s => [s, []]));
  const taskRows = tasks.map(task => {
    const es = byTask.get(task.id) ?? [];
    const integrated = es.find(e => e.stage === 'integration' && e.action === 'integrated');
    const dispatch = es.find(e => e.stage === 'dispatch' && e.action === 'dispatched');
    const elapsed = dispatch && integrated ? Date.parse(integrated.at) - Date.parse(dispatch.at) : null;
    for (const stage of FLOW_STAGES) {
      const starts = es.filter(e => e.stage === stage && ['requested','enqueued','started'].includes(e.action));
      const ends = es.filter(e => e.stage === stage && ['acquired','released','finished','updated','verified','integrated','promoted'].includes(e.action));
      if (starts.length && ends.length) durations[stage]!.push(Math.max(0, Date.parse(ends[ends.length - 1]!.at) - Date.parse(starts[0]!.at)));
    }
    const checks = es.filter(e => e.stage === 'check');
    const waits = checks.reduce((n,e) => n + (e.action === 'requested' ? Date.parse((checks.find(x => x.action === 'acquired' && x.at >= e.at)?.at ?? e.at)) - Date.parse(e.at) : 0), 0);
    const running = es.filter(e => e.stage === 'worker' && ['started','finished'].includes(e.action));
    let workingTime = 0, openStart: number | null = null;
    for (const event of running) { if (event.action === 'started') openStart = Date.parse(event.at); else if (openStart !== null) { workingTime += Math.max(0, Date.parse(event.at)-openStart); openStart = null; } }
    const working = running.some(e=>e.action==='started') ? Math.max(0, workingTime - waits) : null;
    return { taskId: task.id, goal: task.brief.goal, elapsedMs: elapsed, workingMs: working, efficiency: elapsed && working !== null ? working / elapsed : null };
  });
  const queues = ['start','check','landing','verification','promotion'].map(stage => {
    const pending = ordered.filter(e => e.stage === stage && ['requested','enqueued'].includes(e.action) && !ordered.some(x => x.taskId === e.taskId && x.at >= e.at && x.stage === stage && ['started','acquired','released','verified','promoted','integrated'].includes(x.action)));
    return {stage, length:pending.length, oldestAgeMs:pending.length ? now - Date.parse(pending[0]!.at) : 0, tasks:pending.map(e => e.taskId)};
  });
  const stages = FLOW_STAGES.map(stage => { const a = durations[stage]!.sort((x,y)=>x-y); return {stage,totalMs:a.reduce((x,y)=>x+y,0),p50Ms:percentile(a,.5),p90Ms:percentile(a,.9)}; });
  const waiting = queues.map(q => ({stage:q.stage,ms:q.oldestAgeMs}));
  const attempts = ordered.reduce((m,e)=> { if(e.stage==='worker'&&e.action==='started')m.set(e.taskId,(m.get(e.taskId)??0)+1); return m; },new Map<string,number>());
  const integratedIds = new Set(ordered.filter(e=>e.stage==='integration'&&e.action==='integrated').map(e=>e.taskId));
  const summarize = (values:number[]) => { const sorted=[...values].sort((a,b)=>a-b); return {totalMs:sorted.reduce((a,b)=>a+b,0),p50Ms:percentile(sorted,.5),p90Ms:percentile(sorted,.9)}; };
  const efficiencyRows=taskRows.filter(t=>t.elapsedMs!==null&&t.workingMs!==null);
  return { stages, goals: [...new Set(tasks.map(t=>t.brief.goal))].map(goal=>{const rows=taskRows.filter(t=>t.goal===goal); return {goal,...summarize(rows.flatMap(t=>t.elapsedMs===null?[]:[t.elapsedMs])),stages:FLOW_STAGES.map(stage=>({stage,...summarize(rows.flatMap(row=>{const es=byTask.get(row.taskId)??[]; const starts=es.filter(e=>e.stage===stage&&['requested','enqueued','started'].includes(e.action)); const ends=es.filter(e=>e.stage===stage&&['acquired','released','finished','updated','verified','integrated','promoted'].includes(e.action)); return starts.length&&ends.length?[Math.max(0,Date.parse(ends[ends.length-1]!.at)-Date.parse(starts[0]!.at))]:[];}))}))};}), tasks:taskRows, queues, bottleneck: waiting.sort((a,b)=>b.ms-a.ms)[0]?.stage ?? null, flowEfficiency: efficiencyRows.length ? efficiencyRows.reduce((n,t)=>n+(t.workingMs??0),0)/efficiencyRows.reduce((n,t)=>n+(t.elapsedMs??0),0) : null, attemptsPerIntegrated: integratedIds.size ? [...integratedIds].reduce((n,id)=>n+(attempts.get(id)??0),0)/integratedIds.size : null };
}

export type FlowThresholds = { efficiencyBelow: number; oldestQueueMs: number; landingP90Ms: number; attemptsPerIntegrated: number };
export const DEFAULT_FLOW_THRESHOLDS: FlowThresholds = { efficiencyBelow: .4, oldestQueueMs: 60*60_000, landingP90Ms: 30*60_000, attemptsPerIntegrated: 1.5 };
export function checkFlowAlarms(db: Database, report: ReturnType<typeof flowReport>, inbox: (summary: string) => void, now = new Date(), thresholds = DEFAULT_FLOW_THRESHOLDS): string[] {
  ensureFlow(db);
  const breaches: [string,string,string][] = [];
  if (report.flowEfficiency !== null && report.flowEfficiency < thresholds.efficiencyBelow) breaches.push(['flow-efficiency','working vs elapsed',`${(report.flowEfficiency*100).toFixed(1)}%`]);
  for (const q of report.queues) if (q.oldestAgeMs > thresholds.oldestQueueMs) breaches.push([`queue-${q.stage}`,q.stage,`${Math.round(q.oldestAgeMs/60000)} min`]);
  const landing = report.stages.find(s=>s.stage==='landing'); if (landing && landing.p90Ms > thresholds.landingP90Ms) breaches.push(['landing-p90','landing',`${Math.round(landing.p90Ms/60000)} min p90`]);
  if (report.attemptsPerIntegrated !== null && report.attemptsPerIntegrated > thresholds.attemptsPerIntegrated) breaches.push(['attempts-per-integrated','worker',report.attemptsPerIntegrated.toFixed(2)]);
  const sent: string[] = [];
  for (const [key,stage,measurement] of breaches) {
    const old = db.query('SELECT sent_at FROM flow_alarm_sends WHERE threshold=?').get(key) as {sent_at:string}|null;
    if (old && now.getTime()-Date.parse(old.sent_at)<3600000) continue;
    const top = [...report.queues].sort((a,b)=>b.oldestAgeMs-a.oldestAgeMs).flatMap(q=>q.tasks).slice(0,3);
    inbox(`Flow alarm: stage ${stage}; measurement ${measurement}; top waiting tasks ${top.join(', ') || 'none'}`);
    db.query('INSERT OR REPLACE INTO flow_alarm_sends(threshold,sent_at) VALUES (?,?)').run(key,now.toISOString()); sent.push(key);
  }
  return sent;
}
export function dispatchDailyStepAudit(db: Database, tasks: Task[], dispatch: () => Task, now = new Date()): Task | null {
  ensureFlow(db);
  const day = now.toISOString().slice(0,10);
  if (db.query('SELECT 1 FROM flow_audit_runs WHERE day=?').get(day)) return null;
  const open = tasks.find(task => task.brief.goal === 'daily-step-audit' && !['integrated','merged','stopped','cancelled'].includes(task.state));
  if (open) { db.query('INSERT INTO flow_audit_runs(day,task_id) VALUES (?,?)').run(day,open.id); return null; }
  const audit = dispatch();
  db.query('INSERT INTO flow_audit_runs(day,task_id) VALUES (?,?)').run(day,audit.id);
  return audit;
}
