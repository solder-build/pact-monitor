FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.docker.json ./
COPY src ./src
RUN npm install && npx tsc -p tsconfig.docker.json

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/schema.sql ./dist/schema.sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
