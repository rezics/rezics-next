import { localMediaStorage, type LocalMediaBindings, type MediaStorage } from './storage.ts';
import { download, validVariant } from './download.ts';
import { dependencyUnavailable, notFound, problem, problemResponse } from './kernel.ts';
import { upload } from './upload.ts';
import { avatarUploadAdvice, reserve, read } from './reservation.ts';

export type MediaEnv = { KERNEL_ORIGIN: string; MEDIA: MediaStorage };

export async function mediaRequest(
  request: Request,
  bindings: Partial<MediaEnv & LocalMediaBindings> = {},
): Promise<Response> {
  try {
    const env = {
      ...bindings,
      MEDIA:
        bindings.MEDIA ??
        (bindings.LOCAL_MEDIA_ORIGIN && bindings.LOCAL_MEDIA_TOKEN
          ? localMediaStorage({
              LOCAL_MEDIA_ORIGIN: bindings.LOCAL_MEDIA_ORIGIN,
              LOCAL_MEDIA_TOKEN: bindings.LOCAL_MEDIA_TOKEN,
            })
          : undefined),
    };
    if (!env.MEDIA || !env.KERNEL_ORIGIN) throw dependencyUnavailable(503);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/media/avatar-upload-advice') {
      if (request.method !== 'GET')
        return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow: 'GET' });
      return await avatarUploadAdvice(request, env as MediaEnv);
    }
    if (pathname === '/media') {
      if (request.method !== 'POST')
        return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow: 'POST' });
      return await reserve(request, env as MediaEnv);
    }
    const path = /^\/media\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/.exec(pathname);
    if (!path || (path[2] !== undefined && !validVariant(path[2]))) throw notFound();
    const [, id, variant] = path;
    const allow = variant === undefined ? 'GET, PUT' : 'GET, HEAD';
    if (!(variant === undefined ? ['GET', 'PUT'] : ['GET', 'HEAD']).includes(request.method))
      return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow });
    if (variant !== undefined) return await download(request, id!, variant, env as MediaEnv);
    return request.method === 'GET'
      ? await read(request, id!, env as MediaEnv)
      : await upload(request, id!, env as MediaEnv);
  } catch (error) {
    const response = problemResponse(error);
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }
}
