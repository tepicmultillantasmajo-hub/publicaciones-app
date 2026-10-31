'use strict';
const { html, raw, ROLES } = require('./plantilla');
const { config } = require('./config');
const { tomarFlash } = require('./seguridad');
const db = require('./db');

const ICONOS = {
  publicar: '<path d="M12 5v14M5 12h14"/>',
  lista: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  paginas: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  equipo: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  bitacora: '<path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  negocios: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>',
  cuenta: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  salir: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};
function icono(nombre) {
  return raw(`<svg class="icono" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[nombre] || ''}</svg>`);
}

function enlacesNav(ctx, negocio) {
  const u = ctx.usuario;
  const ruta = ctx.url.pathname;
  const enlaces = [];
  if (u.rol === 'admin') enlaces.push({ href: '/negocios', texto: 'Negocios', icono: 'negocios', exacto: true });
  const nid = negocio ? negocio.id : u.negocio_id;
  if (nid) {
    const base = `/negocios/${nid}`;
    const pendientes = u.rol === 'proveedor' ? 0
      : db.get("SELECT COUNT(*) AS n FROM publicaciones WHERE negocio_id = ? AND estado = 'pendiente'", nid).n;
    enlaces.push({ href: `${base}/publicar`, texto: 'Publicar', icono: 'publicar' });
    enlaces.push({
      href: `${base}/publicaciones`, texto: u.rol === 'proveedor' ? 'Mis publicaciones' : 'Publicaciones',
      icono: 'lista', contador: pendientes,
    });
    if (u.rol !== 'proveedor') {
      enlaces.push({ href: `${base}/paginas`, texto: 'Páginas', icono: 'paginas' });
      enlaces.push({ href: `${base}/equipo`, texto: 'Equipo', icono: 'equipo' });
      enlaces.push({ href: `${base}/bitacora`, texto: 'Bitácora', icono: 'bitacora' });
    }
    if (u.rol === 'admin') enlaces.push({ href: `${base}/ajustes`, texto: 'Ajustes', icono: 'ajustes' });
  }
  return enlaces.map((e) => {
    const activo = e.exacto ? ruta === e.href : ruta === e.href || ruta.startsWith(e.href + '/');
    return html`<a href="${e.href}" class="${activo ? 'activo' : ''}">${icono(e.icono)}<span>${e.texto}</span>${
      e.contador ? html`<b class="contador" title="Por aprobar">${e.contador}</b>` : ''}</a>`;
  });
}

function pagina(ctx, { titulo, contenido, negocio = null, ancho = false }) {
  const u = ctx.usuario;
  const mensajes = tomarFlash(ctx);
  const nombreNegocio = negocio ? negocio.nombre : u && u.negocio_nombre;
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${ctx.sesion.csrf}">
<title>${titulo} · ${config.nombreApp}</title>
<link rel="icon" href="/static/icono.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css?v=1">
<script src="/static/app.js?v=1" defer></script>
</head>
<body>
${u ? html`
<header class="barra">
  <div class="marca"><a href="/">${icono('publicar')}<span>${config.nombreApp}</span></a>${
    nombreNegocio ? html`<span class="negocio-actual">${nombreNegocio}</span>` : ''}</div>
  <button class="menu-movil" type="button" aria-label="Abrir menú" data-alternar-menu>☰</button>
  <nav class="nav" id="nav">
    ${enlacesNav(ctx, negocio)}
    <span class="separador"></span>
    <a href="/cuenta" class="solo-icono ${ctx.url.pathname === '/cuenta' ? 'activo' : ''}" title="Mi cuenta · ${u.nombre} (${ROLES[u.rol]})">${icono('cuenta')}<span>${u.nombre}</span></a>
    <form method="post" action="/salir" class="en-linea">
      <input type="hidden" name="_csrf" value="${ctx.sesion.csrf}">
      <button type="submit" class="enlace-boton solo-icono" title="Salir">${icono('salir')}<span>Salir</span></button>
    </form>
  </nav>
</header>` : ''}
<main class="${ancho ? 'contenido ancho' : 'contenido'}">
  ${mensajes.map((m) => html`<div class="aviso ${m.tipo}" role="status">${m.mensaje}</div>`)}
  ${contenido}
</main>
</body>
</html>`.s;
}

const csrfInput = (ctx) => html`<input type="hidden" name="_csrf" value="${ctx.sesion.csrf}">`;

module.exports = { pagina, csrfInput, icono };
