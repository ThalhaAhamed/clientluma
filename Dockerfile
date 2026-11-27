FROM node:25-trixie-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
RUN mkdir /app/data

FROM gcr.io/distroless/nodejs22-debian13:nonroot

WORKDIR /app
COPY --from=dependencies /app/package.json ./
COPY --from=dependencies /app/node_modules ./node_modules/
COPY --from=dependencies --chown=1000:1000 /app/data ./data/
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

ENV NODE_ENV=production MIA_LISTEN_HOST=0.0.0.0 MIA_DATA_DIR=/app/data PORT=4000 HOME=/app/data PATH=/nodejs/bin:/usr/bin
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["/nodejs/bin/node", "-e", "const socket=require('node:net').connect(Number(process.env.PORT), '127.0.0.1'); socket.on('connect',()=>socket.end()); socket.on('error',()=>process.exit(1));"]
CMD ["server.js"]
