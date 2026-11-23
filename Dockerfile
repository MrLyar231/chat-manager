# 1) Собираем React-клиент
FROM node:20-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# 2) Финальный образ: только сервер + готовый клиент
FROM node:20-slim
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=client-build /app/client/dist ./public

ENV PORT=10000
ENV DB_PATH=/data/chat.db
ENV CLIENT_DIST=./public

EXPOSE 10000
CMD ["node", "index.js"]
