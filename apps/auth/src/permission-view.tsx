import { useId } from 'react';
import { AuthButton as Button } from './button';
import type { Consent } from './consent';
import { m } from './paraglide/messages.js';
import { permissionDescription, permissionRemovalLabel } from './permission-description';

/** Plain list content; the native token remains separate, visible secondary text. */
export function Permission({ scope }: { scope: string }) {
  const { label, detail } = permissionDescription(scope);
  return (
    <>
      <span className="wrap-anywhere">{label}</span>
      <code className="font-mono text-sm text-muted-foreground wrap-anywhere">{scope}</code>
      <span className="text-sm text-muted-foreground wrap-anywhere">{detail}</span>
    </>
  );
}

export function RequestedPermission({ scope, consent }: { scope: string; consent: Consent }) {
  return (
    <>
      <Permission scope={scope} />
      <span className="text-sm text-muted-foreground">
        {!consent.scopes.includes(scope)
          ? m.auth_consent_not_available()
          : consent.granted.includes(scope)
            ? m.auth_consent_already_granted()
            : m.auth_consent_new()}
      </span>
    </>
  );
}

export function RemovablePermission({ scope, onRemove }: { scope: string; onRemove: () => void }) {
  const descriptionId = useId();
  return (
    <>
      <div id={descriptionId} className="grid min-w-0 gap-1">
        <Permission scope={scope} />
      </div>
      <Button
        type="button"
        variant="outline"
        className="justify-self-start text-start"
        aria-label={permissionRemovalLabel(scope)}
        aria-describedby={descriptionId}
        onClick={onRemove}
      >
        {m.auth_permission_description_remove({ permission: permissionDescription(scope).label })}
      </Button>
    </>
  );
}

export function PermissionLimits() {
  return <p className="text-sm text-muted-foreground wrap-anywhere">{m.auth_permission_description_limits()}</p>;
}
