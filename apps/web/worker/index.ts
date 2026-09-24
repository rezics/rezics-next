import handler from 'vinext/server/fetch-handler';

export default {
  fetch(request: Request, env: Parameters<typeof handler.fetch>[1],
    context: Parameters<typeof handler.fetch>[2]): Promise<Response> {
    return handler.fetch(request, env, context);
  },
};
