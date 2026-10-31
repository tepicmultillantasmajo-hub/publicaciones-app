'use strict';
// Plantillas HTML con escape automático: todo lo interpolado se escapa,
// salvo lo que ya es HTML generado por html`` o marcado con raw().
const { config } = require('./config');

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Raw(String(s));

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}
function html(strings, ...valores) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < valores.length) out += fmt(valores[i]);
  });
  return new Raw(out);
}

// SQLite guarda fechas UTC como 'YYYY-MM-DD HH:MM:SS' o ISO.
function aFecha(valor) {
  if (!valor) return null;
  const s = String(valor);
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}
const formatoFecha = new Intl.DateTimeFormat('es-MX', {
  timeZone: config.zonaHoraria, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
function fecha(valor) {
  const d = aFecha(valor);
  return d ? formatoFecha.format(d) : '—';
}
function hace(valor) {
  const d = aFecha(valor);
  if (!d) return '—';
  const seg = Math.round((Date.now() - d.getTime()) / 1000);
  if (seg < 60) return 'hace un momento';
  const min = Math.round(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return fecha(valor);
}

const ESTADOS = {
  pendiente: { texto: 'Por aprobar', clase: 'amarillo' },
  rechazada: { texto: 'Rechazada', clase: 'gris' },
  en_cola: { texto: 'En cola', clase: 'azul' },
  publicando: { texto: 'Publicando…', clase: 'azul' },
  publicada: { texto: 'Publicada', clase: 'verde' },
  error: { texto: 'Error', clase: 'rojo' },
};
function insigniaEstado(estado) {
  const e = ESTADOS[estado] || { texto: estado, clase: 'gris' };
  return html`<span class="insignia ${e.clase}">${e.texto}</span>`;
}

const ROLES = { admin: 'Administrador general', dueno: 'Dueño del negocio', proveedor: 'Proveedor' };

// Miniatura generada por Cloudinary a partir de la URL original.
function miniatura(pub, tam = 160) {
  if (!pub.media_url || !pub.media_url.includes('/upload/')) return '';
  const t = `c_fill,w_${tam},h_${tam}`;
  if (pub.tipo === 'video') {
    return pub.media_url.replace('/upload/', `/upload/so_1,${t}/`).replace(/\.[a-z0-9]+$/i, '.jpg');
  }
  return pub.media_url.replace('/upload/', `/upload/${t}/`);
}

function recortar(texto, n = 120) {
  const s = String(texto || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { html, raw, esc, fecha, hace, insigniaEstado, ESTADOS, ROLES, miniatura, recortar, Raw };
