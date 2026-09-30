ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY . .
ENV YARN_ENABLE_SCRIPTS=false YARN_ENABLE_IMMUTABLE_INSTALLS=true
RUN bun yarn.cjs workspaces focus @rezics/main @rezics/account @rezics/content --production \
    && rm yarn.cjs

FROM ${BUN_IMAGE} AS runtime
ARG ROLE=main
ARG SOURCE_DATE_EPOCH=0
WORKDIR /app
ENV NODE_ENV=production REZICS_ROLE=${ROLE}
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=dependencies --chown=bun:bun /app/services ./services
COPY --from=dependencies --chown=bun:bun /app/packages ./packages
COPY --from=dependencies --chown=bun:bun /app/generated ./generated
COPY --from=dependencies --chown=bun:bun /app/scripts ./scripts
COPY --from=dependencies --chown=bun:bun /app/apps ./apps
COPY --from=dependencies --chown=bun:bun /app/infra/release ./infra/release
COPY --from=dependencies --chown=bun:bun /app/release.json ./release.json
USER bun
ENTRYPOINT ["bun", "infra/release/entrypoint.ts"]
