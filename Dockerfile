# Void Freighter game server — serves the built client, REST API and the
# authoritative WebSocket world on one port. Pair with the postgres service
# from docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
RUN npm run build && npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8788
USER node
CMD ["node", "dist-server/server.cjs"]
