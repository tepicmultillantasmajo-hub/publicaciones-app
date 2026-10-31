'use strict';
const db = require('../db');
const { html, fecha } = require('../plantilla');
const { pagina } = require('../layout');
const { enviar } = require('../http');
const { ACCIONES } = require('../auditoria');
const { requiereSesion, negocioDeRuta } = require('../acceso');

const POR_PAGINA = 50;

function describir(detalle) {
  if (!detalle) return '';
  let d;
  try { d = JSON.parse(detalle); } catch { return ''; }
  const partes = [];
  if (d.publicacion) partes.push(`#${d.publicacion}`);
  if (d.pagina) partes.push(d.pagina);
  if (d.nombre) partes.push(d.nombre);
  if (d.email) partes.push(d.email);
  if (d.motivo) partes.push(`Motivo: ${d.motivo}`);
  if (d.error) partes.push(d.error);
  if (d.estado === 'pendiente') partes.push('(requiere aprobación)');
  if (d.activo === false) partes.push('(desactivado)');
  if (d.texto_editado) partes.push('(texto corregido)');
  if (d.accion) partes.push(d.accion);
  return partes.join(' · ');
}

function registrarRutas(r) {
  r.get('/negocios/:nid/bitacora', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const pag = Math.max(1, Number(ctx.query.p) || 1);
    const filas = db.all(
      `SELECT b.*, u.nombre AS usuario FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
        WHERE b.negocio_id = ? ORDER BY b.id DESC LIMIT ? OFFSET ?`,
      negocio.id, POR_PAGINA + 1, (pag - 1) * POR_PAGINA,
    );
    const hayMas = filas.length > POR_PAGINA;
    enviar(ctx.res, 200, pagina(ctx, {
      titulo: `Bitácora · ${negocio.nombre}`, negocio, ancho: true,
      contenido: html`
<div class="encabezado"><h1>Bitácora</h1><p class="sutil">Registro de quién hizo qué y cuándo. No se puede editar ni borrar.</p></div>
${filas.length ? html`
<div class="tabla-envoltura"><table class="tabla">
  <thead><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead>
  <tbody>${filas.slice(0, POR_PAGINA).map((b) => html`
    <tr><td class="nowrap">${fecha(b.creado)}</td><td>${b.usuario || html`<span class="sutil">Sistema</span>`}</td>
      <td>${ACCIONES[b.accion] || b.accion}</td><td>${describir(b.detalle)}</td><td><small class="sutil">${b.ip}</small></td></tr>`)}
  </tbody></table></div>
<nav class="paginacion">
  ${pag > 1 ? html`<a class="boton chico" href="?p=${pag - 1}">← Más recientes</a>` : ''}
  ${hayMas ? html`<a class="boton chico" href="?p=${pag + 1}">Anteriores →</a>` : ''}
</nav>` : html`<div class="vacio">Sin movimientos todavía.</div>`}`,
    }));
  });
}

module.exports = { registrarRutas };
