# Despliegue en VPS (Ubuntu 22.04/24.04)

Guía paso a paso para levantar el agente Conducar en un servidor con IP pública.

**Arquitectura** (todo en un `docker-compose.yml`):
- `app` — agente WhatsApp + panel CRM + webhook (puerto `3000`, público)
- `postgres` — BD del agente (solo red interna)
- `evolution-api` — pasarela WhatsApp (solo `127.0.0.1:8080`, no expuesta)
- `evolution-db` + `evolution-redis` — dependencias de Evolution (solo red interna)

---

## 1. Requisitos
- Ubuntu 22.04 o 24.04 con acceso SSH.
- El código ya está en `https://github.com/mrfowks/agenteconducar`.
- Una **API key de OpenAI** y una **clave nueva de Evolution** (no reutilizar la local).

## 2. Instalar Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Cierra sesión y vuelve a entrar (o ejecuta `newgrp docker`) para usar `docker` sin `sudo`.

## 3. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 3000/tcp
sudo ufw enable
sudo ufw status
```

No se abre el puerto `8080`: Evolution está ligado a `127.0.0.1`.

## 4. Clonar y configurar el entorno

```bash
git clone https://github.com/mrfowks/agenteconducar.git
cd agenteconducar
cp .env.example .env
nano .env
```

En `.env` cambia **obligatoriamente**:
- `OPENAI_API_KEY=sk-...` (la tuya real)
- `EVOLUTION_API_KEY=` (clave nueva; el compose la usa como `AUTHENTICATION_API_KEY`)
- `ADMIN_TOKEN=` (token nuevo del panel)
- `PANEL_PASSWORD=` (password nueva del operador)

Las variables `DATABASE_URL`, `EVOLUTION_API_URL`, `PORT` y `BASE_URL` las sobreescribe el compose con las URLs internas (`postgres:5432`, `evolution-api:8080`, `app:3000`); puedes dejarlas como están en el ejemplo.

## 5. Levantar el stack

```bash
docker compose up -d --build
docker compose ps
```

El contenedor `app` corre automáticamente `prisma migrate deploy` y luego arranca.

## 6. Sembrar la base de conocimiento (solo la primera vez)

```bash
docker compose exec app node dist/prisma/seed.js
```

Crea/actualiza categorías (A1…A3C), paquetes (P1–P5) y reglas de agenda. Es idempotente, se puede volver a ejecutar.

## 7. Verificar

```bash
curl http://localhost:3000/health          # {"status":"ok",...}
curl -I http://localhost:3000/panel/       # 200
docker compose logs -f app                 # seguimiento de logs
```

## 8. Vincular el número del negocio (WhatsApp)

Solo una vez. `TU_EVOLUTION_API_KEY` = valor de `EVOLUTION_API_KEY` del paso 4.

**a) Crear la instancia** (si no existe):

```bash
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: TU_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceName": "conducar",
    "integration": "WHATSAPP-BAILEYS",
    "qrcode": true,
    "webhook": {
      "url": "http://app:3000/webhook/evolution",
      "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "SEND_MESSAGE"],
      "enabled": true
    },
    "setting": {
      "rejectCall": true,
      "msgCall": "Estamos atendiendo por chat, escríbenos.",
      "groupsIgnore": true,
      "alwaysOnline": false,
      "readMessages": true,
      "readStatus": false,
      "syncFullHistory": false
    }
  }'
```

**b) Generar el QR** (devuelve `base64`):

```bash
curl http://localhost:8080/instance/connect/conducar -H "apikey: TU_EVOLUTION_API_KEY" > qr.json
node -e "const fs=require('fs');const r=require('./qr.json');fs.writeFileSync('./public/QRWhatsApp.jpeg',Buffer.from(r.base64.replace(/^data:image\/png;base64,/,''),'base64'))"
```

**c) Escanear**: abre `http://IP_DEL_VPS:3000/QRWhatsApp.jpeg` en el navegador y escanéalo con **WhatsApp → Dispositivos vinculados → Vincular dispositivo** usando el número del negocio. El QR vence en ~45 s; si pasa, repite el paso (b).

**d) Confirmar conexión**:

```bash
curl http://localhost:8080/instance/connectionState/conducar -H "apikey: TU_EVOLUTION_API_KEY"
# debe devolver "state": "open"
```

**e) Prueba real**: envía un WhatsApp al número del negocio y verifica en `http://IP_DEL_VPS:3000/panel/` y en `docker compose logs -f app`.

## 9. Actualizar el agente (cada mejora)

Desde tu PC haces `git push`; en el VPS:

```bash
cd agenteconducar
git pull
docker compose up -d --build
```

Los cambios de la carpeta `public/` (flyers, QR) se aplican al instante porque está montada como volumen.

## 10. opencode en el VPS (opcional, para desarrollar ahí)

```bash
curl -fsSL https://opencode.ai/install | bash
cd agenteconducar
opencode
```

## 11. Checklist de seguridad
- [ ] `.env` con secrets nuevos (OpenAI, Evolution, panel).
- [ ] Puertos abiertos solo: `22`, `80`, `3000`.
- [ ] `8080` ligado a `127.0.0.1` (por defecto en el compose).
- [ ] Contraseña del panel fuerte (`PANEL_PASSWORD`).
- [ ] (Recomendado) A futuro: dominio + Caddy/Let's Encrypt para HTTPS del panel.

## Solución de problemas rápida
- `docker compose logs -f app` → errores del agente.
- `docker compose logs -f evolution-api` → errores de WhatsApp/QR.
- Si el QR no aparece: verifica que el volumen `./public` exista y que `QRWhatsApp.jpeg` se haya escrito.
- Reiniciar todo limpio: `docker compose down` y repetir desde el paso 5 (la BD en volumen persiste).
