FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/podmena.sqlite
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY certs ./certs
COPY package.json ./package.json
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
