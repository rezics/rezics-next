import type { ComponentType } from 'react';
import type { MediaReservationIntent, UploadResponseWait, UploadStageUpdate } from '../../threads/upload-vocabulary';

export type SettingsContentFailure = {
  status: number;
  problem: Record<string, unknown>;
  headers?: HeadersInit;
};
export type SettingsContentFailureReader = (error: unknown) => SettingsContentFailure | undefined;

export type AvatarUploadAdvice = {
  viewerState: 'signed_in';
  viewer: { accountId: string };
  target: { containerId: string; purpose: 'avatar' };
  constraints: {
    mediaTypes: readonly ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];
    maxByteCount: 20971520;
  };
  allowedActions: ['upload'] | [];
};
export type AvatarAdviceReadResult = {
  ok: boolean;
  body?: unknown;
  retryAfter?: string;
  responseTime: number;
};
export type AvatarAdviceRead = (
  signal: AbortSignal,
  onResponseWait?: UploadResponseWait,
) => Promise<AvatarAdviceReadResult>;
export type AvatarUpload = (
  accountId: string,
  file: File,
  signal: AbortSignal,
  intent?: MediaReservationIntent,
  onStage?: UploadStageUpdate,
  onResponseWait?: UploadResponseWait,
) => Promise<{ src: string }>;
export type AvatarResume = (
  mediaId: string,
  file: File,
  signal: AbortSignal,
  onStage?: UploadStageUpdate,
  intent?: MediaReservationIntent,
  onResponseWait?: UploadResponseWait,
) => Promise<{ src: string }>;
export type SettingsAvatarMedia = {
  createIntent: (accountId: string, file: File) => MediaReservationIntent;
  upload: AvatarUpload;
  resume: AvatarResume;
  readAdvice: AvatarAdviceRead;
};

/** Validate Content's response where it enters Settings; native viewer and target identity stay bound. */
export function parseAvatarUploadAdvice(value: unknown, viewerId: string): AvatarUploadAdvice | null {
  const mediaTypes = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'] as const;
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const viewer = body.viewer as Record<string, unknown> | undefined;
  const target = body.target as Record<string, unknown> | undefined;
  const constraints = body.constraints as Record<string, unknown> | undefined;
  const types = constraints?.mediaTypes;
  const actions = body.allowedActions;
  if (
    body.viewerState !== 'signed_in' ||
    !viewer ||
    typeof viewer.accountId !== 'string' ||
    viewer.accountId === '' ||
    viewer.accountId !== viewerId ||
    !target ||
    target.containerId !== viewer.accountId ||
    target.purpose !== 'avatar' ||
    !constraints ||
    !Array.isArray(types) ||
    types.length !== mediaTypes.length ||
    mediaTypes.some((type, index) => types[index] !== type) ||
    constraints.maxByteCount !== 20_971_520 ||
    !Array.isArray(actions) ||
    (actions.length !== 0 && (actions.length !== 1 || actions[0] !== 'upload'))
  )
    return null;
  return {
    viewerState: 'signed_in',
    viewer: { accountId: viewer.accountId },
    target: { containerId: viewer.accountId, purpose: 'avatar' },
    constraints: { mediaTypes, maxByteCount: 20_971_520 },
    allowedActions: actions.length === 1 ? ['upload'] : [],
  };
}

export type SettingsPromptProps = { returnTo: string; label?: string; compact?: boolean };
export type SettingsPrompt = ComponentType<SettingsPromptProps>;
export type SettingsContentPresentation = {
  coverSrc: (media: string, format: 'avif' | 'webp', width: number) => string;
  initials: (name: string, fallback?: string) => string;
  threadHref: (locale: string, thread: { id: string; title?: string | null }) => string;
  SignInPrompt: SettingsPrompt;
};

export type SettingsContentPort = SettingsContentPresentation & {
  mediaFailure: SettingsContentFailureReader;
  avatar: SettingsAvatarMedia;
};
