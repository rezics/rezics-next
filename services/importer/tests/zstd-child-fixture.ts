/** Repository-owned zstd child stand-in for hang, late-fail and stderr-flood cases. */
const mode = process.argv[2] ?? 'help';

if (mode === 'help' || process.argv.includes('-H')) {
  process.stdout.write('*** fixture ***\n  -d, --decompress\n  -c, --stdout\n  -M#\n  --[no-]pass-through\n');
  process.exit(0);
}

if (mode === 'hang-term') {
  process.on('SIGTERM', () => {});
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
}

if (mode === 'copy-then-fail') {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  process.stdout.write(Buffer.concat(chunks));
  process.exit(1);
}

if (mode === 'flood-stderr') {
  const junk = Buffer.alloc(32 * 1024, 0x61);
  for (let i = 0; i < 64; i++) process.stderr.write(junk);
  for await (const chunk of process.stdin) process.stdout.write(chunk as Buffer);
  process.exit(0);
}
