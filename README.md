# Centro de Publicaciones

App web multi-negocio para que proveedores externos publiquen en Facebook e Instagram
(muro + historias) **sin tener acceso a Meta**. Cada proveedor entra con su propio usuario
y solo ve las páginas que se le asignan. La publicación la ejecuta el workflow motor de n8n.

- **Roles:** administrador general, dueño del negocio, proveedor.
- **Aprobación configurable** por proveedor (publica directo o requiere aprobación).
- **Bitácora** inalterable de accesos y acciones.
- **Tokens de Meta cifrados** (AES-256-GCM); nunca llegan al navegador.
- **Subida firmada a Cloudinary** desde el servidor y validación de formato, peso, medidas y duración.
- **Sin dependencias externas:** solo Node.js 22 (SQLite integrado).

## Flujo

1. El navegador sube el archivo a la app (en streaming a disco).
2. La app lo valida, lo sube a Cloudinary y crea la publicación (`pendiente` o `en_cola`).
3. La cola envía a n8n por la red interna: `POST N8N_WEBHOOK_URL` con cabecera
   `X-Publicador-Secret` y cuerpo `{publicacion_id, negocio, pagina, page_id, ig_id, url, tipo (image|video), texto, token}`.
4. n8n publica y responde al final (nodo *Respond to Webhook*). Respuesta 2xx = publicada; cualquier otra = error.

## Despliegue (Hostinger)

1. Al subir a `main`, GitHub Actions publica la imagen `ghcr.io/<usuario>/publicaciones-app:latest`
   (el paquete debe quedar **público** para que el VPS lo descargue sin credenciales).
2. DNS: registro `A` del subdominio apuntando a la IP del VPS.
3. Administrador de Docker → nuevo proyecto con `docker-compose.hostinger.yml` (valores reales en lugar de `CAMBIAR`).
4. Para actualizar: subir cambios a GitHub, esperar la imagen y en Hostinger volver a implementar el proyecto.

Datos persistentes en el volumen `publicaciones_datos` (`/data/publicaciones.db`).

## Desarrollo local

```bash
cp .env.example .env   # y llena los valores
COOKIE_SECURE=false DATA_DIR=./datos node --env-file=.env src/server.js
```
