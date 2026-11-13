import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { fromPlainText, type DocumentSnapshot, serializeDocument } from '@rezics/document';
import type { NativeWebStack } from './stack.ts';
import { createPublishAttachmentWorkBoard } from './publish-attachment-reply-fixture.ts';

export type JourneyPost = Readonly<{
  title: string;
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
  body: DocumentSnapshot;
}>;

export type HostedBookJourneySeed = Readonly<{
  subjectId: string;
  subjectTitle: string;
  boardId: string;
  author: KernelClient;
  anonymous: KernelClient;
  opening: JourneyPost;
  chapterOne: JourneyPost;
  chapterTwo: JourneyPost;
}>;

export type HostedReaderControl = Readonly<{
  subjectId: string;
  subjectTitle: string;
  author: KernelClient;
  member: KernelClient;
  anonymous: KernelClient;
  catalogueId: string;
  structureRevisionId: string;
  publicationRevisionId: string;
  occurrenceId: string;
  chapter: JourneyPost;
}>;

type GeneratedResult<T> = Readonly<{ status: number; error: unknown; data: T | null | undefined }>;

function admitted<T>(result: GeneratedResult<T>, expected: number, operation: string): T {
  if (result.status !== expected || result.error || result.data == null) {
    throw new Error(
      `${operation} returned HTTP ${result.status}: ${result.error ? String(result.error) : 'no response data'}`,
    );
  }
  return result.data;
}

/** Keep generated client calls inside this attempt's native stack and retain its request observations. */
export function nativeKernelClient(stack: NativeWebStack, persona: string, authorization?: string): KernelClient {
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    return stack.kernel(
      `${url.pathname}${url.search}`,
      {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
        signal: request.signal,
      },
      persona,
    );
  };
  return createKernelClient(stack.kernelOrigin, {
    fetch: fetcher,
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

function digest(body: DocumentSnapshot): string {
  return createHash('sha256')
    .update(Buffer.from(serializeDocument(body), 'utf8'))
    .digest('hex');
}

async function createJourneySubject(stack: NativeWebStack, label: string) {
  const board = await createPublishAttachmentWorkBoard(stack);
  const credential = await stack.authPersona('alice');
  const author = nativeKernelClient(stack, 'alice', credential.authorization);
  const subjectTitle = `${label} · The Lantern Ferry`;
  const created = await author.subjects.post(
    { type: 'schema:Book', labels: { en: subjectTitle } },
    { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } },
  );
  const data = admitted(created, 201, 'Generated Book subject creation') as { subject: { id: string } };
  return {
    board,
    author,
    subjectId: data.subject.id,
    subjectTitle,
    member: nativeKernelClient(stack, 'bob', (await stack.authPersona('bob')).authorization),
    anonymous: nativeKernelClient(stack, 'anonymous'),
  };
}

async function createPost(
  author: KernelClient,
  boardId: string,
  subjectId: string,
  title: string,
  text: string,
  visibility: 'draft' | 'published' = 'draft',
): Promise<JourneyPost> {
  const body = fromPlainText(text);
  const result = await author.threads.post(
    {
      boardId,
      title,
      body,
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [subjectId],
      visibility,
    },
    { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } },
  );
  const data = admitted(result, 201, `Generated ${visibility} manuscript creation`) as {
    thread: {
      id: string;
      firstPost: {
        availability: string;
        id: string;
        revisionId: string;
        sha256: string;
      };
    };
  };
  const post = data.thread.firstPost;
  if (post.availability !== 'available') throw new Error(`Generated manuscript ${title} has no saved body`);
  if (post.sha256 !== digest(body))
    throw new Error(`Generated manuscript ${title} digest differs from its source bytes`);
  return {
    title,
    threadId: data.thread.id,
    postId: post.id,
    revisionId: post.revisionId,
    sha256: post.sha256,
    body,
  };
}

export async function createHostedBookJourneySeed(
  stack: NativeWebStack,
  label = 'Private draft journey',
): Promise<HostedBookJourneySeed> {
  const base = await createJourneySubject(stack, label);
  const opening = await createPost(
    base.author,
    base.board.boardId,
    base.subjectId,
    `${label} · Book opening`,
    'At the last ferry of the evening, Mara found a brass lantern still warm from the crossing.',
  );
  const chapterOne = await createPost(
    base.author,
    base.board.boardId,
    base.subjectId,
    `${label} · Chapter one draft`,
    'Mara counted the lights along the harbor while the tide carried the ferry home.',
  );
  const chapterTwo = await createPost(
    base.author,
    base.board.boardId,
    base.subjectId,
    `${label} · Chapter two draft`,
    'At dawn, the ferryman left a map beneath the lantern for the next traveler.',
  );
  return {
    subjectId: base.subjectId,
    subjectTitle: base.subjectTitle,
    boardId: base.board.boardId,
    author: base.author,
    anonymous: base.anonymous,
    opening,
    chapterOne,
    chapterTwo,
  };
}

export async function readNativePost(client: KernelClient, postId: string) {
  const result = await client.posts({ id: postId }).get();
  const data = admitted(result, 200, `Generated exact Post read ${postId}`) as {
    post: { availability: string; id: string; revisionId: string; sha256: string; body: DocumentSnapshot };
  };
  if (data.post.id !== postId || data.post.availability !== 'available')
    throw new Error(`Generated exact Post read ${postId} did not return its available body`);
  return data.post;
}

export async function createPrepublishedReaderControl(stack: NativeWebStack): Promise<HostedReaderControl> {
  const base = await createJourneySubject(stack, 'Prepublished reader control');
  const opening = await createPost(
    base.author,
    base.board.boardId,
    base.subjectId,
    'Prepublished reader control · Book record',
    'This one-chapter control exists only to exercise the mounted reader after a separate author journey.',
    'published',
  );
  const chapter = await createPost(
    base.author,
    base.board.boardId,
    base.subjectId,
    'Prepublished reader control · Chapter draft',
    'A separate reader control keeps its own lantern beside the harbor steps.',
  );
  const occurrenceId = randomUUID();
  const created = await base.author.hostedCatalogues.post(
    {
      postId: opening.postId,
      threadId: opening.threadId,
      placements: [
        {
          occurrenceId,
          parentId: null,
          position: 0,
          title: 'Control chapter · Beside the harbor steps',
          kind: 'chapter',
          target: {
            threadId: chapter.threadId,
            postId: chapter.postId,
            revisionId: chapter.revisionId,
            sha256: chapter.sha256,
          },
        },
      ],
    },
    { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } },
  );
  const structure = admitted(created, 201, 'Generated one-chapter control outline creation') as {
    catalogueId: string;
    revisionId: string;
  };
  const published = await base.author.hostedCatalogues({ id: opening.postId }).$publish.post(
    {
      expectedRevisionId: structure.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [occurrenceId],
    },
    { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } },
  );
  const release = admitted(published, 200, 'Generated one-chapter control publication') as {
    catalogueId: string;
    revisionId: string;
  };
  if (structure.catalogueId !== opening.postId || release.catalogueId !== opening.postId)
    throw new Error('Generated control outline changed its catalogue identity');
  return {
    subjectId: base.subjectId,
    subjectTitle: base.subjectTitle,
    author: base.author,
    member: base.member,
    anonymous: base.anonymous,
    catalogueId: opening.postId,
    structureRevisionId: structure.revisionId,
    publicationRevisionId: release.revisionId,
    occurrenceId,
    chapter,
  };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    table[value] = current >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksumData = Buffer.concat([name, data]);
  let checksum = 0xffffffff;
  for (const byte of checksumData) checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  const checksumBytes = Buffer.alloc(4);
  checksumBytes.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, checksumData, checksumBytes]);
}

/** A deterministic, test-owned cover image with no external file or network dependency. */
export function lanternFerryCoverPng(): Buffer {
  const width = 64;
  const height = 80;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const water = y >= 51 && ((x + y) % 11 < 2 || y > 64);
      const lantern = x >= 27 && x <= 36 && y >= 22 && y <= 47;
      const glow = x >= 22 && x <= 41 && y >= 18 && y <= 49 && !lantern;
      if (lantern) pixels.set([39, 48, 51, 255], offset);
      else if (glow) pixels.set([232, 177, 89, 255], offset);
      else if (water) pixels.set([48, 98, 117, 255], offset);
      else pixels.set([238, 224, 194, 255], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
