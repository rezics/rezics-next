/** Only the systemd hierarchy identifies the supervisor's unit; a controller's
 * directory with a unit-like name is not evidence of systemd ownership. */
export function coordinatorPassCommand(cgroup: string, command: string[]): string[] {
  const inUnit = cgroup.split('\n').some(line => {
    const match = /^\d+:([^:]*):(.+)$/.exec(line);
    return match && (match[1] === '' || match[1]!.split(',').includes('name=systemd'))
      && match[2]!.split('/').some(part => /\.(service|scope)$/.test(part));
  });
  return inUnit
    ? ['systemd-run', '--user', '--scope', '--collect', '--quiet', '--expand-environment=no', '--', ...command]
    : [...command];
}
