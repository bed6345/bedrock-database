# Backend image for the Redis-backed RemoteDatabase API.
FROM node:20-alpine

WORKDIR /app

# Only the redis client is needed at runtime.
RUN npm install --no-save redis@^4

COPY server.redis.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.redis.js"]
