FROM node:22-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "dist/src/bot.js"]