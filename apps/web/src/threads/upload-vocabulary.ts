/** The image operations shared by Content's transport and Settings' consumer-owned avatar port. */
export type UploadRefusalReason = 'closed' | 'type' | 'too-large' | 'rejected' | 'rate-limited' | 'unavailable';

export class UploadRefusal extends Error {
  readonly reason: UploadRefusalReason;
  readonly retryAfter?: number;
  retryAfterHeader?: string;
  responseTime?: number;
  /** Retain a known reservation when completion or processing has an uncertain outcome. */
  mediaId?: string;
  constructor(reason: UploadRefusalReason, retryAfter?: number) {
    super(reason);
    this.name = 'UploadRefusal';
    this.reason = reason;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export type UploadStage = 'reservation' | 'transfer' | 'processing';
export type UploadStageUpdate = (stage: UploadStage, mediaId?: string) => void;
export type UploadResponseWait = (status: number, retryAfterHeader: string | undefined, responseTime: number) => void;

export type UploadReservationBody = Readonly<
  (
    | { containerId: string }
    | { realmId: string }
    | { newThread: Readonly<{ boardId: string; idempotencyKey: string }> }
  ) & {
    purpose: 'post-image' | 'avatar' | 'realm-icon' | 'realm-banner';
    mediaType: string;
    byteCount: number;
  }
>;

/** One immutable upload command. Settings shares this lifecycle vocabulary without owning Content transport. */
export type MediaReservationIntent = Readonly<{
  key: string;
  body: UploadReservationBody;
  file: File;
  viewer: string;
  credential: string;
}>;
