// Runs the pinned Knip analyzer. It prints a proxy warning whenever proxy
// variables exist, although analysis makes no network requests.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(?:https?|all|no)_proxy$/i.test(key)),
);
const child = Bun.spawn(['node_modules/.bin/knip', '--no-progress', ...process.argv.slice(2)], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
