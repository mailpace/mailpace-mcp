# syntax=docker/dockerfile:1

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json index.ts ./
RUN npm run build

FROM node:24-alpine AS runtime

LABEL io.modelcontextprotocol.server.name="com.mailpace/mailpace-mcp"

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

USER node

CMD ["node", "build/index.js"]
