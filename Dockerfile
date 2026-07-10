FROM node:22-alpine
WORKDIR /app

# Dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Source + build
COPY . .
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev --legacy-peer-deps

# Memory directory — persistent storage comes from the Railway service volume
# mounted at /app/memory (Railway's Metal builder rejects Dockerfile VOLUME:
# "dockerfile invalid: docker VOLUME ... not supported, use Railway Volumes").
RUN mkdir -p /app/memory/atlas/telegram-conversations /app/memory/atlas/episodes /app/memory/atlas/swarm-runs

ENV NODE_ENV=production
ENV MEMORY_ROOT=/app

# Bot health endpoint on port 3000 (Railway health check)
EXPOSE 3000

CMD ["node", "dist/cli.js", "telegram"]
