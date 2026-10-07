import { expect, test } from 'bun:test';
import { Client, DatabaseError } from 'pg';
import { boundedPool } from './pg-pool.ts';

test('the deadlock observer selects only the direct SQLSTATE and runs before query delivery', async () => {
  const pool = boundedPool({ connectionString: 'postgres://private@127.0.0.1:1/private' });
  const client = new Client();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  const error = new DatabaseError('private-error-text', 0, 'error');
  error.code = '40P01';
  let delivered: unknown;
  client.connection.on('errorMessage', (received: unknown) => {
    delivered = received;
    if (received === error) expect(lines).toHaveLength(1);
  });
  try {
    pool.emit('connect', client);
    client.connection.emit('errorMessage', { code: '23505', message: 'private-duplicate' });
    client.connection.emit('errorMessage', new Error('private-wrapper', { cause: error }));
    client.connection.emit('errorMessage', { code: '40p01' });
    expect(lines).toHaveLength(0);
    client.connection.emit('errorMessage', error);
    expect(delivered).toBe(error);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        level: 'error',
        event: 'worker_fault',
        'rezics.worker.name': 'main.database.deadlock',
        'error.class': 'DatabaseError',
        'error.code': '40P01',
      },
    ]);
    expect(lines.join('\n')).not.toContain('private');
  } finally {
    console.error = original;
    await pool.end();
  }
});
