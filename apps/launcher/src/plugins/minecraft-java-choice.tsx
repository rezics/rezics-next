import type { MinecraftJavaPolicy } from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';

type Action = { label: string; run: () => void };

export function MinecraftJavaChoice({
  legend,
  runtime,
  disabled,
  choose,
  managed,
  useCurrent,
}: {
  legend: string;
  runtime: MinecraftJavaPolicy | undefined;
  disabled: boolean;
  choose: Action;
  managed: Action;
  useCurrent?: () => void;
}) {
  const executable = runtime?.kind === 'custom' ? runtime.executable : undefined;
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {executable ? (
        <code className="text-sm [overflow-wrap:anywhere]">{executable}</code>
      ) : (
        <p className="muted">Managed Java</p>
      )}
      <div className="actions">
        <Button size="sm" variant="outline" disabled={disabled} onClick={choose.run}>
          {choose.label}
        </Button>
        {executable && (
          <Button size="sm" variant="outline" disabled={disabled} onClick={managed.run}>
            {managed.label}
          </Button>
        )}
        {useCurrent && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={useCurrent}>
            Use current instance Java
          </Button>
        )}
      </div>
    </fieldset>
  );
}
