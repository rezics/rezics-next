/** Builds a docker argv and does not spawn. Callers are still docker calls. */
function docker(command: string[]): string[] {
  return ['docker', 'run', '--rm', ...command];
}

export function compile(): string[] {
  return docker(['javac', 'Oracle.java']);
}
