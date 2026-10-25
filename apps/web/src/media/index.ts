import { download, validVariant } from './download.ts';
import { dependencyUnavailable, notFound, problem, problemResponse } from './kernel.ts';
import { upload } from './upload.ts';

export type MediaEnv = { KERNEL_ORIGIN: string; MEDIA: R2Bucket };

export async function mediaRequest(request: Request, env: Partial<MediaEnv> = {}): Promise<Response> {
  try {
    if (!env.MEDIA || !env.KERNEL_ORIGIN) throw dependencyUnavailable(503);
    const path = /^\/media\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/.exec(new URL(request.url).pathname);
    if (!path || (path[2] !== undefined && !validVariant(path[2]))) throw notFound();
    const [, id, variant] = path;
    const allow = variant === undefined ? 'PUT' : 'GET, HEAD';
    if (!(variant === undefined ? request.method === 'PUT' : ['GET', 'HEAD'].includes(request.method)))
      return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow });
    return variant === undefined
      ? await upload(request, id!, env as MediaEnv)
      : await download(request, id!, variant, env as MediaEnv);
  } catch (error) {
    const response = problemResponse(error);
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }
}
