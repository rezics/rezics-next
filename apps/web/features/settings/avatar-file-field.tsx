'use client';

import { useId, useState } from 'react';

export function AvatarFileField({ label, choose, none, disabled }: {
  label: string; choose: string; none: string; disabled: boolean;
}) {
  const id = useId();
  const [filename, setFilename] = useState<string>();
  return <div className="grid gap-1 text-sm">
    <span className="font-medium">{label}</span>
    <div className="flex min-w-0 items-center gap-3">
      <input id={id} name="avatar" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label={label} disabled={disabled} className="peer sr-only"
        onChange={event => setFilename(event.currentTarget.files?.[0]?.name)} />
      <label htmlFor={id} className={`rounded-md border border-input bg-background px-3 py-1.5 font-medium
        peer-focus-visible:ring-2 peer-focus-visible:ring-ring
        ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent'}`}>{choose}</label>
      <span className="min-w-0 truncate text-muted-foreground">{filename ?? none}</span>
    </div>
  </div>;
}
