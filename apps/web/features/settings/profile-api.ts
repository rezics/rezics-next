import { createHash, randomUUID } from 'node:crypto';
import { serviceOrigin } from '../api/origins.ts';
import type { PublicAgentProfile } from '../auth/agent-profile.ts';

export type ProfileSaveResult = 'saved' | 'invalid' | 'conflict' | 'denied' | 'unavailable'
  | 'avatar-denied' | 'avatar-unavailable';
export type ProfileSender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const avatarTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const avatarMaxBytes = 4 * 1024 * 1024;

interface SaveInput {
  token: string;
  agent: string;
  expectedHead: string;
  displayName: string;
  bio: { text: string; language: string } | null;
  avatarSelection: string | null;
  avatar?: File;
  removeAvatar: boolean;
  expectedAvatarSelection: string | null;
  key: string;
}

/** A selected image becomes a public avatar only after Main admits all three
 * media steps and the profile CAS points to that selection. */
export async function saveAgentProfile(input: SaveInput, send: ProfileSender = fetch): Promise<ProfileSaveResult> {
  const id = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(input.agent)?.[1];
  const name = input.displayName.trim();
  const bio = input.bio && { text: input.bio.text.trim(), language: input.bio.language };
  if (!id || !/^[0-9a-f-]{36}$/.test(input.key) || !input.expectedHead
    || !name || name.length > 200 || /\p{Cc}/u.test(name)
    || bio && (!bio.text || bio.text.length > 500 || /\p{Cc}/u.test(bio.text))
    || input.avatar && (input.avatar.size > avatarMaxBytes || !avatarTypes.has(input.avatar.type))
    || input.avatar && input.removeAvatar) return 'invalid';
  const origin = serviceOrigin('MAIN_ORIGIN');
  const headers = { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' };
  const problem = async (response: Response, media = false): Promise<ProfileSaveResult> => {
    if (response.status === 409) return 'conflict';
    if (response.status === 400 || response.status === 413 || response.status === 422) return 'invalid';
    if (response.status === 403) return media ? 'avatar-denied' : 'denied';
    return media ? 'avatar-unavailable' : 'unavailable';
  };
  let mediaStage = false;
  try {
    let selection = input.avatarSelection;
    let asset: string | null = null;
    if (input.avatar) {
      mediaStage = true;
      const bytes = new Uint8Array(await input.avatar.arrayBuffer());
      const reserved = await send(`${origin}/v1/media/uploads`, { method: 'POST',
        headers: { ...headers, 'idempotency-key': randomUUID() }, cache: 'no-store',
        body: JSON.stringify({ profile: 'media-image-upload-v1', asset: null,
          mediaType: input.avatar.type, byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), disclosure: 'public',
          actingSubject: input.agent }) });
      if (!reserved.ok) return problem(reserved, true);
      const upload = await reserved.json() as { asset: string; upload: string };
      asset = upload.asset;
      const uploaded = await send(`${origin}/v1/media/uploads/${upload.upload}/bytes`, {
        method: 'PUT', headers: { authorization: `Bearer ${input.token}`, 'content-type': input.avatar.type },
        body: bytes, cache: 'no-store',
      });
      if (!uploaded.ok) return problem(uploaded, true);
      const outcome = await uploaded.json() as { status: string };
      if (outcome.status !== 'activated') return 'invalid';
    }
    if (input.avatar || input.removeAvatar && input.expectedAvatarSelection) {
      mediaStage = true;
      const selected = await send(`${origin}/v1/resources/${id}/avatar`, { method: 'PUT',
        headers: { ...headers, 'idempotency-key': randomUUID() }, cache: 'no-store',
        body: JSON.stringify({ profile: 'resource-avatar-selection-v1', expectedSelection: input.expectedAvatarSelection,
          asset, actingSubject: input.agent }) });
      if (!selected.ok) return problem(selected, true);
      selection = input.removeAvatar ? null : (await selected.json() as { selection: string }).selection;
    }
    mediaStage = false;
    const saved = await send(`${origin}/v1/agents/${id}/profile`, { method: 'PUT',
      headers: { ...headers, 'idempotency-key': input.key }, cache: 'no-store',
      body: JSON.stringify({ profile: 'agent-public-profile-v1', expectedHead: input.expectedHead,
        displayName: name, bio, avatarSelection: selection }) });
    if (!saved.ok) return problem(saved);
    await saved.body?.cancel();
    return 'saved';
  } catch { return mediaStage ? 'avatar-unavailable' : 'unavailable'; }
}

export function profileSaveInput(profile: PublicAgentProfile, values: {
  token: string; agent: string; displayName: string; bioText: string; locale: string;
  avatar?: File; removeAvatar: boolean; key: string;
}): SaveInput {
  const text = values.bioText.trim();
  return { token: values.token, agent: values.agent, expectedHead: profile.revision,
    displayName: values.displayName, bio: text ? { text,
      language: profile.bio?.text === text ? profile.bio.language : values.locale } : null,
    avatarSelection: profile.avatarSelection, expectedAvatarSelection: profile.avatarSelection,
    avatar: values.avatar, removeAvatar: values.removeAvatar, key: values.key };
}
