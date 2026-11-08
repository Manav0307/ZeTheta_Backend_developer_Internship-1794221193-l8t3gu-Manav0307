# Build Stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency definitions
COPY package*.json tsconfig.json ./

# Install all dependencies including devDependencies for build
RUN npm ci

# Copy application source code and migrations
COPY src/ ./src/
COPY docs/ ./docs/

# Compile TypeScript to JavaScript in /dist
RUN npm run build

# Production Stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy compiled files and documentation
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docs ./docs
COPY src/database/migrations ./dist/database/migrations
COPY src/database/seeds ./dist/database/seeds

# Run as non-root user
USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]

