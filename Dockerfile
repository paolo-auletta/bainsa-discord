FROM node:22-bookworm-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev


FROM node:22-bookworm-slim

WORKDIR /workspace
ENV NODE_ENV=production

COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/db ./db

CMD ["node", "--enable-source-maps", "dist/src/bot.js"]