export interface PurposeCopy { subject: string; body: string; action: string }

export interface EmailCopy {
  verify: PurposeCopy;
  reset: PurposeCopy;
  'change-email': PurposeCopy;
  notice: PurposeCopy;
  digest: PurposeCopy;
  ignore: string;
  digestMore: string;
  digestLine: (topic: string, count: number) => string;
}
