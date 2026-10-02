/** Minimal loopback PostgreSQL wire peer: real pg client, no shared database. */
export function postgresPeer() {
  const packet = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeInt32BE(data.length + 4);
    return Buffer.concat([Buffer.from(type), length, data]);
  };
  const ready = packet('Z', Buffer.from('I'));
  const auth = packet('R', Buffer.alloc(4));
  const field = Buffer.alloc(18);
  field.writeInt32BE(23, 6);
  field.writeInt16BE(4, 10);
  field.writeInt32BE(-1, 12);
  const row = packet('T', Buffer.concat([Buffer.from([0, 1]), Buffer.from('value\0'), field]));
  const value = packet('D', Buffer.from([0, 1, 0, 0, 0, 1, 49]));
  const complete = packet('C', Buffer.from('SELECT 1\0'));
  const server = Bun.listen<{ started: boolean; pending: Buffer }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { started: false, pending: Buffer.alloc(0) };
      },
      data(socket, bytes) {
        socket.data.pending = Buffer.concat([socket.data.pending, Buffer.from(bytes)]);
        while (socket.data.pending.length >= 5) {
          const offset = socket.data.started ? 1 : 0;
          const size = socket.data.pending.readInt32BE(offset) + offset;
          if (socket.data.pending.length < size) return;
          const type = socket.data.pending[0];
          socket.data.pending = socket.data.pending.subarray(size);
          if (!socket.data.started) {
            socket.data.started = true;
            socket.write(Buffer.concat([auth, ready]));
          } else if (type === 81) socket.write(Buffer.concat([row, value, complete, ready]));
          else if (type === 88) socket.end();
        }
      },
    },
  });
  return server;
}
