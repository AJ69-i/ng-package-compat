# syntax=docker/dockerfile:1.7
# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install deps with cache-friendly layering
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy source and build browser + server bundles
COPY . .
RUN npm run build -- --configuration=production

# ---------- runtime stage (SSR via Node) ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

# Copy only runtime artifacts
COPY --from=build /app/package.json /app/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 4000
USER node

# Angular 21 SSR server (emitted at dist/ng-package-compat/server/server.mjs)
CMD ["node", "dist/ng-package-compat/server/server.mjs"]
