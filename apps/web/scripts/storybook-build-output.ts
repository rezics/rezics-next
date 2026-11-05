const maximumDiagnosticLength = 8_000;
const omission = '\n... [output omitted] ...\n';

function boundedOutput(output: string, limit: number): string {
  if (output.length <= limit) return output;
  const retained = limit - omission.length;
  const beginning = Math.ceil(retained / 2);
  return `${output.slice(0, beginning)}${omission}${output.slice(output.length - (retained - beginning))}`;
}

export function formatBuildOutput(stdout: string, stderr: string): string {
  const stderrLabel = stderr ? '[stderr]\n' : '';
  const stdoutLabel = stdout ? '[stdout]\n' : '';
  const separator = stderr && stdout ? '\n' : '';
  const available = maximumDiagnosticLength - stderrLabel.length - stdoutLabel.length - separator.length;
  // Reserve most of a long diagnostic for native stderr; either stream can use the other's unused space.
  const stderrLimit = Math.min(stderr.length, Math.max(6_000, available - stdout.length));
  return (
    `${stderrLabel}${boundedOutput(stderr, stderrLimit)}${separator}` +
    `${stdoutLabel}${boundedOutput(stdout, available - stderrLimit)}`
  );
}
