'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';
import { initials } from '@rezics/ui/avatar-initials';

export interface AvatarUser { name: string; email: string; image: string | null }

/** The account picture, or the same initials shown on the main site. */
export function UserAvatar({ user, className, size = 'md' }: { user: AvatarUser; className?: string;
  size?: 'sm' | 'md' | 'lg' }) {
  return <Avatar size={size} className={className}>
    {user.image ? <AvatarImage src={user.image} alt="" /> : null}
    <AvatarFallback className="font-semibold">{initials(user.name || user.email)}</AvatarFallback>
  </Avatar>;
}
