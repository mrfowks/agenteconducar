# =============================================================================
# Dockerfile — Conducar Agent (build reproducible de producción)
#
# Multi-stage:
#   stage build   → npm ci (lockfile), prisma generate, tsc build
#   stage runtime → npm ci --omit=dev, dist + prisma + panel + public,
#                   usuario no-root `node`, CMD = migrate deploy + arranque.
#
# Decisiones:
#   - npm ci SIEMPRE (package-lock.json v3; falla si el lock no está
#     sincronizado con package.json).
#   - Las MIGRACIONES se ejecutan en el CMD (arranque), NUNCA durante el build.
#   - Multi-platform NO requerido: solo linux/amd64 (documentado).
#   - nginx log/health: el /health del agente lo usa el healthcheck del compose.
# =============================================================================

# ── STAGE 1: BUILD ──────────────────────────────────────────────────────────
FROM node:20-slim AS build

# Prisma 5 necesita openssl (+ ca-certificates para HTTPS) en imágenes slim.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalación determinista desde el lockfile (sin versión "instalada" del host).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Generar el cliente Prisma a partir del schema (en BUILD, no en runtime).
COPY prisma ./prisma
RUN npx prisma generate

# Compilar TypeScript → dist/ (incluye dist/src y dist/prisma por tsconfig).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── STAGE 2: RUNTIME ────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Persistencia de media (vouchers/adjuntos). Se monta como volumen en compose
# (/data/uploads). Solo se crea y se da permisos; los datos viven en el volume.
RUN mkdir -p /data/uploads

# Dependencias de SOLO producción (determinista, sin node_modules del host)
# + CLI de Prisma (devDependency) instalado aislado (--no-save) en la MISMA
# versión que fija el lockfile (FUENTE DE VERDAD: .packages['node_modules/prisma']),
# sin tocar package.json/package-lock.json. Todo en un ÚNICO RUN para que
# `npm cache clean --force` borre la caché de npm en la MISMA capa; si se
# limpiara en un RUN posterior, la caché seguiría contando en el tamaño.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund \
    && PRISMA_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version") \
    && npm install --no-save --omit=dev --no-audit --no-fund --package-lock=false prisma@$PRISMA_VERSION \
    && npx prisma generate \
    && npm cache clean --force

# Código compilado + estáticos (panel del operador y archivos públicos).
COPY --from=build /app/dist ./dist
COPY panel ./panel
COPY public ./public

# Usuario no-root (node:20-slim trae el usuario "node"). /app y /data/uploads
# pasan a ser de `node` para que el proceso y la persistencia sean escribibles.
RUN chown -R node:node /app /data/uploads

USER node

EXPOSE 3000

# Migraciones al arrancar (no en build) y luego el agente.
# `exec` reemplaza el `sh` por `node`: Node pasa a ser PID 1 y recibe
# SIGTERM/SIGINT directamente (sin supervisores). El `sh` solo existe durante
# `prisma migrate deploy`; si la migración falla, && impide arrancar el agente.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/src/index.js"]