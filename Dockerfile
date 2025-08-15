# ---------- Build stage ----------
    FROM node:20-bookworm-slim AS build
    WORKDIR /app
    
    # System deps for native modules (better-sqlite3, etc.)
    RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
      && rm -rf /var/lib/apt/lists/*
    
    # Install deps
    COPY package*.json ./
    RUN npm ci
    
    # Build client
    COPY . .
    RUN npm run build
    
    # ---------- Runtime stage ----------
    FROM node:20-bookworm-slim AS runtime
    WORKDIR /app
    ENV NODE_ENV=production
    
    # Only prod deps
    COPY package*.json ./
    RUN npm ci --omit=dev
    
    # App files
    COPY --from=build /app/server.js ./server.js
    COPY --from=build /app/dist ./dist
    
    # Cache dir (persists via volume)
    RUN mkdir -p .cache/thumbs
    
    # The app will listen on PORT (we’ll set it to 6363 at run time)
    EXPOSE 6363
    
    # Run!
    CMD ["node", "server.js"]
    