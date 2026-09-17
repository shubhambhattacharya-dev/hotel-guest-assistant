# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy backend dependency definitions first for Docker layer caching
COPY backend/package*.json backend/tsconfig.json ./

# Install dependencies, including dev dependencies
RUN npm ci

# Copy backend source
COPY backend/src ./src

# Compile TypeScript
RUN npm run build


# Stage 2: Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# Copy backend package files
COPY backend/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled backend
COPY --from=builder /app/dist ./dist

# Run as non-root user
USER node

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]