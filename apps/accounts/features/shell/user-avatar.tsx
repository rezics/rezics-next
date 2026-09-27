'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';

export interface AvatarUser { name: string; email: string; image: string | null }

function initials(value: string): string {
  return [...value.trim()][0]?.toUpperCase() ?? '?';
}

/** The account picture, or its initial on the accent surface until one is set. */
export function UserAvatar({ user, className, size = 'md' }: { user: AvatarUser; className?: string;
  size?: 'sm' | 'md' | 'lg' }) {
  return <Avatar size={size} className={className}>
    {user.image ? <AvatarImage src={user.image} alt="" /> : null}
    <AvatarFallback className="font-semibold">{initials(user.name || user.email)}</AvatarFallback>
  </Avatar>;
}
