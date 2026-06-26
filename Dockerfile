FROM node:20-alpine
WORKDIR /app

# Dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Source + build
COPY . .
RUN npm run build

# Memory directory (ephemeral, survives container restarts but not redeploys)
RUN mkdir -p /app/memory/atlas/telegram-conversations /app/memory/atlas/episodes /app/memory/atlas/swarm-runs

ENV NODE_ENV=production
ENV MEMORY_ROOT=/app/memory

# Bot health endpoint on port 3000 (Railway health check)
EXPOSE 3000

CMD ["node", "dist/cli.js", "telegram"]
