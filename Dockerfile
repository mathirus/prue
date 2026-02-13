FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY config/ config/
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./
COPY config/ config/

RUN mkdir -p data logs

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
