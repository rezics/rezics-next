import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoalMailStore } from './mail.ts';

function fixture() {
  const root = join(import.meta.dir, '../../.temp/mail-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  const options = { stateDir: join(dir, 'state'), goals: ['program', 'kernel', 'launch'] };
  const stores: GoalMailStore[] = [];
  return { dir, options, open() { const store = new GoalMailStore(options); stores.push(store); return store; },
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
      expect(receiver.pending('program')).toEqual([{ ...message, goal: 'program', acknowledged: false, acknowledgedAt: null }]);
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
