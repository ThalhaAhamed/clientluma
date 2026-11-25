FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY scripts/ ./scripts/
RUN mkdir /app/data && chown node:node /app/data

ENV NODE_ENV=production MIA_LISTEN_HOST=0.0.0.0 MIA_DATA_DIR=/app/data PORT=4000
USER node
EXPOSE 4000
CMD ["node", "server.js"]
