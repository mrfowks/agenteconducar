# Despliegue en VPS (Ubuntu 22.04/24.04)

Guía para levantar el agente Conducar en un servidor con IP pública.

> **IMPORTANTE (válido desde Fase 3):** el VPS **NO construye** imágenes.
> La imagen se publica en GitHub Container Registry
> (`ghcr.io/mrfowks/agenteconducar`, por el workflow
> `.github/workflows/docker-image.yml`) y el VPS solo hace **pull**.
> Se usa `docker-compose.prod.yml` (no el compose local).

**Arquitectura**:
- `app` — agente WhatsApp + panel CRM + webhook (interno en el contenedor: `3000`; publicado **solo en loopback** `127.0.0.1:3001`). El acceso público lo hace **nginx en el host** (solo `80/443`).
- `postgres` — BD del agente (solo red interna privada, sin puertos públicos).
- Redes: `conducar-prod-net` (privada del agente) + `core-net` (external, compartida del VPS).
- Legacy de fases anteriores (evolution-api y su stack) ya **NO forma parte** de este proyecto.

---

## 1. Requisitos
- Ubuntu 22.04 o 24.04 con acceso SSH.
- La imagen publicada en `ghcr.io/mrfowks/agenteconducar` (se publica desde el repo `https://github.com/mrfowks/agenteconducar`).
- API key de OpenAI y credenciales propias (Meta/Chatwoot/panel).

## 2. Instalar Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Cierra sesión y vuelve a entrar (o ejecuta `newgrp docker`).

## 3. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

La app queda en `127.0.0.1:3001` (no se abre `3001` ni `3000` en el firewall: el único acceso es vía nginx por `80/443`).

## 4. Clonar y configurar el entorno

```bash
git clone https://github.com/mrfowks/agenteconducar.git
cd agenteconducar
cp .env.example .env
nano .env
```

En `.env` cambia **obligatoriamente** (en producción la app **no arranca** con placeholders):
- `OPENAI_API_KEY=sk-...` (la tuya real)
- `ADMIN_TOKEN=` y `PANEL_PASSWORD=` (valores fuertes y aleatorios)
- `POSTGRES_USER=`, `POSTGRES_PASSWORD=` y `POSTGRES_DB=` (valores fuertes; `POSTGRES_PASSWORD` URL-safe alfanumérico)
- `META_*/CHATWOOT_*` y `NODE_ENV=production`

`DATABASE_URL`, `PORT` y `BASE_URL` las sobreescribe el compose con las URLs internas.

## 5. Crear la red external (solo la primera vez)

```bash
docker network create core-net
```

## 6. Levantar el stack (pull desde GHCR, sin build)

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

- Usa `ghcr.io/mrfowks/agenteconducar:${IMAGE_TAG:-latest}` (por defecto `latest`;
  para una versión reproducible: `IMAGE_TAG=sha-abc1234 docker compose -f docker-compose.prod.yml up -d`).
- El contenedor `app` corre automáticamente `prisma migrate deploy` y luego arranca.

## 7. Sembrar la base de conocimiento (solo la primera vez)

```bash
docker compose -f docker-compose.prod.yml exec app node dist/prisma/seed.js
```

Es idempotente, se puede volver a ejecutar.

## 8. Verificar

```bash
curl http://127.0.0.1:3001/health          # {"status":"ok",...}
curl -I http://127.0.0.1:3001/panel/       # 200
docker compose -f docker-compose.prod.yml logs -f app
```

## 9. nginx (exposición pública; solo 80/443)

```bash
sudo apt install nginx
```

Configura un `server` con `proxy_pass http://127.0.0.1:3001;` (y HTTPS cuando tengas dominio).

## 10. Actualizar el agente (cada mejora)

Desde tu PC haces `git push` (el workflow publica la imagen en GHCR). En el VPS:

```bash
cd agenteconducar
git pull          # solo si cambió el compose/prod u otros archivos locales
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

(El VPS nunca ejecuta `--build`.)

## 11. Checklist de seguridad
- [ ] `.env` con secrets fuertes y propios.
- [ ] `NODE_ENV=production` y `ADMIN_TOKEN`/`PANEL_PASSWORD` fuertes (fail-fast activo).
- [ ] Puertos abiertos solo: `22`, `80`, `443`.
- [ ] App en `127.0.0.1:3001` (loopback), PostgreSQL sin puertos públicos.
- [ ] Red `core-net` external creada y `conducar-prod-net` privada (sin `host` network).
- [ ] (Recomendado) Dominio + HTTPS (Caddy/Let's Encrypt / nginx + certbot).

## Solución de problemas rápida
- `docker compose -f docker-compose.prod.yml logs -f app` → errores del agente.
- Si la app no arranca: revisa que `ADMIN_TOKEN`/`PANEL_PASSWORD`/`POSTGRES_*` estén
  definidos y no usen los placeholders del ejemplo (fail-fast produce el motivo en los logs).
- Reiniciar limpio: `docker compose -f docker-compose.prod.yml down` y repetir desde el paso 6
  (la BD en volumen persiste).