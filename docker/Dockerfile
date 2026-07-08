# MSPStack Gateway — multi-stage build, no native deps (node:sqlite built-in)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/gateway/package.json packages/gateway/
RUN npm ci --workspaces --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/gateway/ packages/gateway/
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/gateway/package.json packages/gateway/
RUN npm ci --workspaces --include-workspace-root --omit=dev && npm cache clean --force
COPY --from=build /app/packages/gateway/dist packages/gateway/dist
COPY packages/gateway/public packages/gateway/public

# npx is used to launch stdio upstreams from npm packages
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV DB_PATH=/data/gateway.db \
    MSPSTACK_CONFIG=/data/mspstack.config.json \
    PORT=3100
EXPOSE 3100
CMD ["node", "packages/gateway/dist/index.js"]
