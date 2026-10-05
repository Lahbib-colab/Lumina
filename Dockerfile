# LUMINA : serveur + plateforme + conversion HLS vers MP4
FROM node:20-alpine
RUN apk add --no-cache ffmpeg tini
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LUMINA_DIR=/data \
    BLOCK_PRIVATE=1 \
    TRUST_PROXY=1 \
    RETENTION_HOURS=24

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
