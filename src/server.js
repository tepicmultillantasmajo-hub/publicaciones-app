'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { config, validarConfig } = require('./config');
validarConfig();

const db = require('./db');
db.abrir();

const { Router, leerCookies, leerFormulario, ipCliente, enviar, enviarJson, ErrorHttp } = require('./http');
const seg = require('./seguridad');
const { html } = require('./plantilla');
const { pagina } = require('./layout');
const { iniciarCola } = require('./cola');
const publicaciones = require('./rutas/publicaciones');

// ---------- Rutas ----------
const router = new Router();
require('./rutas/cuenta').registrarRutas(router);
require('./rutas/negocios').registrarRutas(router);
require('./rutas/paginas').registrarRutas(router);
require('./rutas/equipo').registrarRutas(router);
require('./rutas/bitacora').registrarRutas(router);
publicaciones.registrarRutas(router);

// ---------- Archivos estáticos ----------
const DIR_PUBLICO = path.join(__dirname, '..', 'public');
const TIPOS = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const estaticos = new Map();
for (const f of fs.readdirSync(DIR_PUBLICO)) {
  const ext = path.extname(f);
  if (TIPOS[ext]) estaticos.set(`/static/${f}`, { cuerpo: fs.readFileSync(path.join(DIR_PUBLICO, f)), tipo: TIPOS[ext] });
}

// ---------- Cabeceras de seguridad ----------
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://res.cloudinary.com",
  "media-src 'self' blob: https://res.cloudinary.com",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function cabecerasSeguridad(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.cookieSegura) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function paginaError(ctx, status, mensaje) {
  if (!ctx.sesion) return enviar(ctx.res, status, `<h1>${status}</h1>`);
  const titulos = { 400: 'Algo no salió bien', 403: 'Sin acceso', 404: 'No encontrado', 413: 'Archivo muy grande', 500: 'Error del servidor' };
  enviar(ctx.res, status, pagina(ctx, {
    titulo: titulos[status] || 'Error',
    contenido: html`<section class="tarjeta angosta error-pagina"><h1>${titulos[status] || 'Error'}</h1><p>${mensaje}</p>
      <a class="boton" href="/">Ir al inicio</a></section>`,
  }));
}

// ---------- Despachador ----------
async function manejar(req, res) {
  cabecerasSeguridad(res);
  const url = new URL(req.url, 'http://local');

  if (req.method === 'GET' && url.pathname === '/salud') return enviarJson(res, 200, { ok: true });
  if (req.method === 'GET' && estaticos.has(url.pathname)) {
    const e = estaticos.get(url.pathname);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return enviar(res, 200, e.cuerpo, e.tipo);
  }

  const ctx = {
    req, res, url,
    query: Object.fromEntries(url.searchParams),
    cookies: leerCookies(req.headers.cookie),
    ip: ipCliente(req),
    origen: config.urlPublica || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`,
    form: {},
  };
  res.setHeader('Cache-Control', 'no-store');

  try {
    seg.cargarSesion(ctx);
    const m = router.buscar(req.method, url.pathname);
    if (!m) throw new ErrorHttp(404, 'La página que buscas no existe.');
    ctx.params = m.params;

    if (req.method === 'POST') {
      let token = req.headers['x-csrf-token'];
      if (!m.opciones.crudo) {
        ctx.form = await leerFormulario(req);
        token = token || ctx.form._csrf;
      }
      if (!seg.csrfValido(ctx, token)) {
        throw new ErrorHttp(403, 'La sesión del formulario expiró. Recarga la página e inténtalo de nuevo.');
      }
    }
    await m.fn(ctx);
  } catch (e) {
    const status = e instanceof ErrorHttp ? e.status : 500;
    if (status === 500) console.error(e);
    const mensaje = status === 500 ? 'Ocurrió un error inesperado. Si se repite, avisa al administrador.' : e.message;
    const quiereJson = (req.headers.accept || '').includes('application/json');
    if (res.headersSent) return res.end();
    if (quiereJson) return enviarJson(res, status, { error: mensaje });
    paginaError(ctx, status, mensaje);
  }
}

// ---------- Arranque ----------
function crearAdminInicial() {
  if (db.get("SELECT 1 AS x FROM usuarios WHERE rol = 'admin'")) return;
  if (!config.adminEmail || !config.adminPassword) {
    console.error('No hay administrador. Define ADMIN_EMAIL y ADMIN_PASSWORD para crear el primero.');
    process.exit(1);
  }
  const problema = seg.validarPasswordNueva(config.adminPassword);
  if (problema) {
    console.error(`ADMIN_PASSWORD no es válida: ${problema}`);
    process.exit(1);
  }
  db.run(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash, rol, debe_cambiar_password)
     VALUES (NULL, 'Administrador', ?, ?, 'admin', 1)`,
    config.adminEmail, seg.hashPassword(config.adminPassword),
  );
  console.log(`Administrador inicial creado: ${config.adminEmail} (se pedirá cambiar la contraseña al entrar).`);
}

crearAdminInicial();
publicaciones.limpiarSubidasViejas();
setInterval(() => {
  try {
    db.run('DELETE FROM sesiones WHERE expira < ?', new Date().toISOString());
    publicaciones.limpiarSubidasViejas();
  } catch (e) { console.error('Limpieza:', e.message); }
}, 15 * 60e3).unref();

const servidor = http.createServer((req, res) => {
  manejar(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) enviar(res, 500, 'Error');
  });
});
servidor.requestTimeout = 15 * 60e3; // subidas de video lentas
servidor.headersTimeout = 60e3;
servidor.listen(config.puerto, () => {
  console.log(`${config.nombreApp} escuchando en el puerto ${config.puerto}`);
  iniciarCola();
});

function apagar() {
  console.log('Apagando…');
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10e3).unref();
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);
