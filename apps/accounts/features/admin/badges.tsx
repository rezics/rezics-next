'use client';

import { Badge } from '@rezics/ui/badge';
import { BanIcon, CircleCheckIcon, KeyRoundIcon, MailWarningIcon, ShieldIcon } from 'lucide-react';
import type { OperatorRole, UserStatus } from './api/types.ts';
import { useTranslation } from '../../i18n/client.ts';

// Colour always comes with an icon and words (never colour alone).

const statusStyle = { active: ['success', CircleCheckIcon], suspended: ['destructive', BanIcon],
  'password-reset-required': ['warning', KeyRoundIcon] } as const;

export function StatusBadge({ status }: { status: UserStatus }) {
  const { t } = useTranslation('admin');
  const [variant, Icon] = statusStyle[status];
  return <Badge variant={variant} size="sm" pill><Icon aria-hidden="true" />{t.statuses[status]}</Badge>;
}

export function RoleBadge({ role }: { role: OperatorRole }) {
  const { t } = useTranslation('admin');
  return <Badge variant={role === 'owner' ? 'default' : role === 'admin' ? 'soft' : 'outline'} size="sm" pill>
    <ShieldIcon aria-hidden="true" />{t.roles[role]}</Badge>;
}

export function UnverifiedBadge() {
  const { t } = useTranslation('admin');
  return <Badge variant="warning" size="sm" pill><MailWarningIcon aria-hidden="true" />{t.unverified}</Badge>;
}
