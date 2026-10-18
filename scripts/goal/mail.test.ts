import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoalMailStore } from './mail.ts';
import { mailCommand } from './goalctl.ts';

function fixture() {
  const root = join(import.meta.dir, '../../.temp/mail-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const options = { stateDir: join(dir, 'state'), goals: ['program', 'kernel', 'launch'], sender:'launch', now:()=>now };
  const stores: GoalMailStore[] = [];
  return { dir, options, setNow(value: number) { now=value; },
    open() { const store = new GoalMailStore(options); stores.push(store); return store; },
    cleanup() { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function snapshot(dir: string): unknown {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    return stat.isDirectory() ? { name, children: snapshot(path) }
      : { name, content: readFileSync(path).toString('base64'), mtime: stat.mtimeMs };
  });
}

async function childSend(options: ReturnType<typeof fixture>['options'], key: string, body: string, goals = ['program', 'kernel']) {
  const source = `import { GoalMailStore } from ${JSON.stringify(join(import.meta.dir, 'mail.ts'))};
    const store = new GoalMailStore(${JSON.stringify(options)});
    try { console.log(JSON.stringify(store.send(${JSON.stringify(goals)}, ${JSON.stringify(body)}, ${JSON.stringify(key)}))); }
    finally { store.close(); }`;
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('durable Goal mail', () => {
  test('Program receives, acknowledges and replies without a registered product Goal', () => {
    const f = fixture();
    const file = join(f.dir, 'request.md');
    writeFileSync(file, 'Please read the brief');
    const options = { stateDir: f.options.stateDir, goals: ['launch'], callerGoal: 'launch' };
    const program = { ...options, callerGoal: 'program' };
    try {
      const sent = JSON.parse(mailCommand(['send', 'program', '--file', file, '--key', 'program-reading'], options)[0]!);
      expect(JSON.parse(mailCommand(['inbox'], program)[0]!)).toMatchObject({
        id: sent.id, sender: 'launch', goal: 'program', acknowledged: false,
      });
      expect(JSON.parse(mailCommand(['ack', sent.id], program)[0]!)).toMatchObject({
        id: sent.id, goal: 'program', acknowledged: true,
      });
      expect(mailCommand(['inbox'], program)).toEqual([]);
      writeFileSync(file, 'Reading received');
      const reply = JSON.parse(mailCommand(['send', 'launch', '--file', file, '--key', 'program-reply'], program)[0]!);
      expect(JSON.parse(mailCommand(['inbox'], options)[0]!)).toMatchObject({ id: reply.id, sender: 'program' });
      expect(() => mailCommand(['inbox', 'missing'], options)).toThrow('Unknown mail Goal');
    } finally { f.cleanup(); }
  });

  test('sender and deadline survive retries without extending the deadline or changing authorship', () => {
    const f = fixture();
    try {
      const store = f.open();
      const message = store.send('program','Please act','deadline-request',0.5);
      expect(message).toMatchObject({sender:'launch',deadlineMinutes:0.5,deadlineAt:'2026-01-01T00:00:30.000Z'});
      expect(store.inbox('program')[0]).toMatchObject({sender:'launch',deadlineAt:message.deadlineAt});
      f.setNow(Date.parse('2026-01-01T00:10:00Z'));
      expect(store.send('program',message.body,message.key,0.5)).toEqual(message);
      expect(()=>store.send('program',message.body,message.key,1)).toThrow('different payload');
      store.send('program','Far future','future',10_000_000_000);
      expect(store.overdue().map(delivery=>delivery.id)).toEqual([message.id]);
      const other = new GoalMailStore({...f.options,sender:'kernel'});
      try { expect(()=>other.send('program',message.body,message.key,0.5)).toThrow('different payload'); }
      finally { other.close(); }
    } finally { f.cleanup(); }
  });

  test('missing or unknown sender and invalid deadlines are refused before any store is written', () => {
    const f = fixture();
    try {
      for (const sender of ['','missing']) {
        const store = new GoalMailStore({...f.options,sender});
        try { expect(()=>store.send('program','Request','key')).toThrow(sender ? 'Unknown' : 'GOAL_ID'); }
        finally { store.close(); }
      }
      for (const deadline of [0,-1,NaN,Infinity,Number.MAX_VALUE]) {
        expect(()=>f.open().send('program','Request','key',deadline)).toThrow('positive finite');
      }
      expect(existsSync(f.options.stateDir)).toBe(false);
    } finally { f.cleanup(); }
  });

  test('only unacknowledged deliveries past their deadline escalate once, including across restarts', () => {
    const f = fixture();
    try {
      const store = f.open();
      const message = store.send(['program','kernel'],'Request','due',1);
      store.ack('program',message.id);
      f.setNow(Date.parse(message.deadlineAt!));
      store.notifyOverdue();
      expect(store.overdue()).toEqual([]);
      expect(store.pending('launch')).toEqual([]);
      f.setNow(Date.parse(message.deadlineAt!)+1);
      expect(store.overdue().map(delivery=>delivery.goal)).toEqual(['kernel']);
      store.notifyOverdue(); store.notifyOverdue();
      const notice = store.pending('launch')[0]!;
      expect(notice).toMatchObject({sender:'kernel',deadlineAt:null,deadlineMinutes:null});
      expect(notice.body).toContain(message.id);
      expect(notice.body).toContain(message.deadlineAt!);
      expect(store.overdue('kernel')[0]!.overdueAt).toBe('2026-01-01T00:01:00.001Z');
      store.close();
      const restarted = f.open(); restarted.notifyOverdue();
      expect(restarted.pending('launch').map(delivery=>delivery.id)).toEqual([notice.id]);
      expect(restarted.ack('kernel',message.id).overdueAt).not.toBeNull();
      expect(restarted.overdue()).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('deadline processing commits its notification and marker together', () => {
    const f = fixture();
    try {
      const store = f.open(); const message = store.send('kernel','Request','due',1);
      f.setNow(Date.parse(message.deadlineAt!)+1);
      const db = new Database(store.path);
      try {
        db.exec(`CREATE TRIGGER refuse_notice BEFORE INSERT ON deliveries WHEN NEW.goal='launch'
          BEGIN SELECT RAISE(ABORT,'notice failed'); END;`);
        expect(()=>store.notifyOverdue()).toThrow('notice failed');
        expect(store.overdue()[0]!.overdueAt).toBeNull();
        expect(store.pending('launch')).toEqual([]);
        db.exec('DROP TRIGGER refuse_notice');
        store.notifyOverdue();
        expect(store.pending('launch')).toHaveLength(1);
        expect(store.overdue()[0]!.overdueAt).not.toBeNull();
      } finally { db.close(); }
    } finally { f.cleanup(); }
  });

  test('concurrent deadline processors publish one sender notice for each overdue recipient', async () => {
    const f = fixture();
    try {
      const store = f.open(); store.send(['program','kernel'],'Request','due',1); store.close();
      const source = `import { GoalMailStore } from ${JSON.stringify(join(import.meta.dir,'mail.ts'))};
        const store = new GoalMailStore(${JSON.stringify({...f.options,now:undefined})});
        try { store.notifyOverdue(); } finally { store.close(); }`;
      const results = await Promise.all(Array.from({length:6},async()=> {
        const child = Bun.spawn([process.execPath,'-e',source],{stdout:'pipe',stderr:'pipe'});
        return {code:await child.exited,stderr:await new Response(child.stderr).text()};
      }));
      for (const result of results) expect(result.code,result.stderr).toBe(0);
      expect(f.open().pending('launch')).toHaveLength(2);
    } finally { f.cleanup(); }
  },20_000);

  test('legacy mail can be read without writes and upgrades on a later send without inventing historical sender or deadline', () => {
    const f = fixture();
    try {
      mkdirSync(f.options.stateDir);
      const db = new Database(join(f.options.stateDir,'mail.sqlite'));
      db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,key TEXT UNIQUE,body TEXT,createdAt TEXT);
        CREATE TABLE deliveries(messageId TEXT,goal TEXT,acknowledgedAt TEXT,PRIMARY KEY(messageId,goal));
        INSERT INTO messages VALUES('mail:01a114cb-4d63-7f23-bf70-1610b4db2b2b','old','History','2025-01-01T00:00:00.000Z');
        INSERT INTO deliveries VALUES('mail:01a114cb-4d63-7f23-bf70-1610b4db2b2b','program',NULL);`);
      db.close();
      const before = snapshot(f.options.stateDir);
      const store = f.open();
      expect(store.pending('program')[0]).toMatchObject({sender:null,deadlineAt:null,overdueAt:null});
      expect(store.overdue()).toEqual([]); store.notifyOverdue();
      expect(snapshot(f.options.stateDir)).toEqual(before);
      store.send('program','New request','new',1);
      expect(store.pending('program')[0]).toMatchObject({sender:null,deadlineAt:null,overdueAt:null});
      expect(store.pending('program')[1]).toMatchObject({sender:'launch',deadlineMinutes:1});
    } finally { f.cleanup(); }
  });

  test('mail CLI derives its sender from GOAL_ID context and shows the deadline in the inbox', () => {
    const f = fixture();
    const file = join(f.dir,'request.md'); writeFileSync(file,'Please act');
    const args = ['send','program','--file',file,'--key','cli','--deadline','2'];
    try {
      expect(()=>mailCommand(args,{stateDir:f.options.stateDir,goals:f.options.goals})).toThrow('GOAL_ID');
      expect(existsSync(f.options.stateDir)).toBe(false);
      const options = {...f.options,callerGoal:'launch'};
      const sent = JSON.parse(mailCommand(args,options)[0]!);
      expect(sent.sender).toBe('launch');
      expect(Date.parse(sent.deadlineAt)-Date.parse(sent.createdAt)).toBe(120_000);
      expect(JSON.parse(mailCommand(['inbox','program'],options)[0]!)).toMatchObject({sender:'launch',deadlineAt:sent.deadlineAt});
      expect(()=>mailCommand([...args,'--sender','kernel'],options)).toThrow('Invalid option');
      for (const deadline of ['0','-1','NaN','Infinity','nonsense']) {
        expect(()=>mailCommand([...args.slice(0,-1),deadline],options)).toThrow('positive finite');
      }
    } finally { f.cleanup(); }
  });
  test('mail CLI inbox lists what still waits and a Goal\'s acknowledged mail only with --all', () => {
    const f = fixture();
    const file = join(f.dir,'request.md'); writeFileSync(file,'Please act');
    const options = {...f.options,callerGoal:'launch'};
    try {
      const sent = JSON.parse(mailCommand(['send','program','--file',file,'--key','waits'],options)[0]!);
      expect(mailCommand(['inbox','program'],options)).toHaveLength(1);
      mailCommand(['ack',sent.id,'--goal','program'],options);
      expect(mailCommand(['inbox','program'],options)).toEqual([]);
      expect(JSON.parse(mailCommand(['inbox','--all','program'],options)[0]!)).toMatchObject({id:sent.id,acknowledged:true});
      expect(()=>mailCommand(['inbox','program','kernel','--all'],options)).toThrow('one Goal');
    } finally { f.cleanup(); }
  });
  test('committed mail survives closing the sender; each Goal acknowledges separately and retries preserve the receipt', () => {
    const f = fixture();
    try {
      const sender = f.open();
      const message = sender.send(['program', 'kernel', 'program'], '请检查 the shared task', 'request/one');
      expect(message.recipients).toEqual(['kernel', 'program']);
      expect(message.id).toMatch(/^mail:/);
      expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
      sender.close();
      const receiver = f.open();
      expect(receiver.pending('program')).toEqual([{ ...message, goal: 'program', acknowledged: false, acknowledgedAt: null, overdueAt:null }]);
      const receipt = receiver.ack('program', message.id);
      receiver.close();
      const retried = f.open();
      expect(retried.ack('program', message.id)).toEqual(receipt);
      expect(retried.send(['kernel', 'program'], message.body, message.key)).toEqual(message);
      expect(retried.pending('program')).toEqual([]);
      expect(retried.pending('kernel')).toHaveLength(1);
      expect(retried.inbox('program')[0]).toEqual({ ...receipt, source: 'mail' });
    } finally { f.cleanup(); }
  });

  test('a global retry key rejects a changed body or recipient set without altering either delivery', () => {
    const f = fixture();
    try {
      const store = f.open();
      for (const invalid of ['../outside', 'tasks', 'x', 'a'.repeat(42)]) {
        expect(() => new GoalMailStore({ ...f.options, goals: [invalid] })).toThrow('Invalid mail Goal');
      }
      const message = store.send('program', 'original', 'same');
      expect(() => store.send('program', 'changed', 'same')).toThrow('different payload');
      expect(() => store.send('kernel', 'original', 'same')).toThrow('different payload');
      expect(() => store.send(['kernel', 'program'], 'original', 'same')).toThrow('different payload');
      expect(store.pending('program').map(entry => entry.id)).toEqual([message.id]);
      expect(store.pending('kernel')).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('unknown Goals, empty payloads, nonrecipients and foreign inbox IDs are refused', () => {
    const f = fixture();
    try {
      const store = f.open();
      for (const send of [() => store.send('missing', 'body', 'key'),
        () => store.send(['program', 'missing'], 'body', 'key'), () => store.send([], 'body', 'key'),
        () => store.send('program', ' ', 'key'), () => store.send('program', 'body', ' ')]) expect(send).toThrow();
      expect(existsSync(f.options.stateDir)).toBe(false);
      expect(() => store.pending('missing')).toThrow('Unknown');
      expect(() => store.inbox('missing')).toThrow('Unknown');
      expect(() => store.ack('missing', 'invalid')).toThrow('Unknown');
      const message = store.send('program', 'body', 'key');
      expect(() => store.ack('kernel', message.id)).toThrow('not delivered');
      expect(() => store.ack('program', '1')).toThrow('inbox --ack');
      expect(() => store.ack('program', 'regression:program:1')).toThrow('inbox --ack');
      expect(() => store.ack('program', 'legacy:program')).toThrow('Legacy');
      expect(() => store.ack('program', 'bogus')).toThrow('Invalid');
      expect(store.pending('program')).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('reading an empty inbox or a union of mail, Markdown and regressions writes and acknowledges nothing', () => {
    const f = fixture();
    try {
      const reader = f.open();
      expect(reader.inbox('program')).toEqual([]);
      expect(reader.pending('program')).toEqual([]);
      expect(existsSync(f.options.stateDir)).toBe(false);
      const sender = f.open();
      const message = sender.send('program', 'durable body', 'union');
      sender.close();
      mkdirSync(join(f.options.stateDir, 'messages'));
      mkdirSync(join(f.options.stateDir, 'inbox'));
      writeFileSync(join(f.options.stateDir, 'messages/program.md'), '# Earlier requests\nKeep this verbatim.\n');
      const regression = { runId: 'run', atCommit: 'head', after: 'head', goal: 'program', taskIds: [],
        status: 'attributed', classification: 'deterministic', failingTests: ['test'], artifactPaths: ['log'] };
      writeFileSync(join(f.options.stateDir, 'inbox/program.jsonl'), `${JSON.stringify(regression)}\n${JSON.stringify(regression)}\n`);
      writeFileSync(join(f.options.stateDir, 'inbox/program.ack.json'), '[2]');
      const before = snapshot(f.options.stateDir);
      const entries = reader.inbox('program');
      expect(entries.map(entry => entry.source)).toEqual(['mail', 'legacy', 'regression', 'regression']);
      expect(entries[0]).toMatchObject({ id: message.id, acknowledged: false });
      expect(entries[1]).toMatchObject({ body: '# Earlier requests\nKeep this verbatim.\n', acknowledged: false });
      expect(entries[2]).toMatchObject({ ...regression, id: 'regression:program:1', number: 1, acknowledged: false });
      expect(entries[3]).toMatchObject({ acknowledged: true });
      expect(reader.pending('program')).toHaveLength(1);
      expect(reader.inbox('program')).toEqual(entries);
      reader.close();
      expect(snapshot(f.options.stateDir)).toEqual(before);
    } finally { f.cleanup(); }
  });

  test('legacy message location can be selected without changing the regression location', () => {
    const f = fixture();
    const messagesDir = join(f.dir, 'legacy');
    mkdirSync(messagesDir);
    writeFileSync(join(messagesDir, 'program.md'), 'External spool');
    const store = new GoalMailStore({ ...f.options, messagesDir });
    try {
      expect(store.inbox('program')).toEqual([{ source: 'legacy', id: 'legacy:program', goal: 'program',
        path: join(messagesDir, 'program.md'), body: 'External spool', acknowledged: false }]);
      expect(existsSync(f.options.stateDir)).toBe(false);
    } finally { store.close(); f.cleanup(); }
  });

  test('a failed transaction publishes neither a message nor a partial recipient set and can be retried', () => {
    const f = fixture();
    try {
      const store = f.open();
      store.send('launch', 'initialize', 'init');
      const db = new Database(store.path);
      try {
        db.exec(`CREATE TRIGGER refuse_recipient BEFORE INSERT ON deliveries WHEN NEW.goal = 'kernel'
          BEGIN SELECT RAISE(ABORT, 'recipient failed'); END;`);
        expect(() => store.send(['program', 'kernel'], 'atomic', 'atomic')).toThrow('recipient failed');
        expect(store.pending('program')).toEqual([]);
        expect(store.pending('kernel')).toEqual([]);
        expect(db.query('SELECT id FROM messages WHERE key = ?').get('atomic')).toBeNull();
        db.exec('DROP TRIGGER refuse_recipient');
        const message = store.send(['program', 'kernel'], 'atomic', 'atomic');
        expect(store.pending('program')[0]?.id).toBe(message.id);
        expect(store.pending('kernel')[0]?.id).toBe(message.id);
      } finally { db.close(); }
    } finally { f.cleanup(); }
  });

  test('concurrent processes sending the same retry key commit one ID and independent sends are not lost', async () => {
    const f = fixture();
    try {
      const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        childSend(f.options, index < 6 ? 'shared' : `independent-${index}`, index < 6 ? 'same' : `body ${index}`)));
      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const ids = results.map(result => JSON.parse(result.stdout).id as string);
      expect(new Set(ids.slice(0, 6)).size).toBe(1);
      expect(new Set(ids).size).toBe(5);
      const reader = f.open();
      expect(reader.pending('program')).toHaveLength(5);
      expect(reader.pending('kernel')).toHaveLength(5);
    } finally { f.cleanup(); }
  }, 20_000);

  test('competing payloads for a retry key have exactly one winner', async () => {
    const f = fixture();
    try {
      const results = await Promise.all([childSend(f.options, 'race', 'one'), childSend(f.options, 'race', 'two')]);
      expect(results.filter(result => result.code === 0)).toHaveLength(1);
      expect(results.find(result => result.code !== 0)?.stderr).toContain('different payload');
      expect(f.open().pending('program')).toHaveLength(1);
    } finally { f.cleanup(); }
  }, 20_000);

  test('a committed send whose response is lost retries to the same ID after the sender process exits', async () => {
    const f = fixture();
    try {
      const result = await childSend(f.options, 'lost-response', 'persistent');
      expect(result.code, result.stderr).toBe(0);
      // The caller discards the process response; recovery can use only the durable retry key.
      const receiver = f.open();
      const persisted = receiver.pending('program')[0]!;
      expect(receiver.send(['program', 'kernel'], 'persistent', 'lost-response').id).toBe(persisted.id);
      expect(receiver.pending('program')).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('closing is idempotent and operations cannot silently reopen a closed store', () => {
    const f = fixture();
    try {
      const store = f.open();
      store.close(); store.close();
      expect(() => store.inbox('program')).toThrow('closed');
      expect(() => store.send('program', 'body', 'key')).toThrow('closed');
      expect(() => store.ack('program', '1')).toThrow('closed');
    } finally { f.cleanup(); }
  });
});
