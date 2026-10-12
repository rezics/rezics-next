'use client';

import type { ReactNode } from 'react';
import type { PlatformOperationId } from '../api/platform-access.ts';
import { useOperationGate } from './shell-provider.tsx';

/** Keep server-rendered actions inside the same viewer gate as client actions. */
export function OperationGate({ operation, children }: { operation: PlatformOperationId; children: ReactNode }) {
  const operationOpen = useOperationGate();
  return operationOpen(operation) ? children : null;
}
