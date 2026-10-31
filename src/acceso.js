'use strict';
const db = require('./db');
const { ErrorHttp, noEncontrado, prohibido, redirigir } = require('./http');

// Devuelve true si hay usuario con sesión; si no, redirige y devuelve false.
function requiereSesion(ctx) {
  if (!ctx.usuario) {
    redirigir(ctx.res, '/login');
    return false;
  }
  if (ctx.usuario.debe_cambiar_password && ctx.url.pathname !== '/cuenta') {
    redirigir(ctx.res, '/cuenta');
    return false;
  }
  return true;
}

function soloAdmin(ctx) {
  if (ctx.usuario.rol !== 'admin') throw prohibido();
}

// Carga el negocio de la URL y verifica que el usuario pueda entrar con alguno de los roles dados.
function negocioDeRuta(ctx, roles = ['admin', 'dueno', 'proveedor']) {
  const nid = Number(ctx.params.nid);
  if (!Number.isInteger(nid)) throw noEncontrado();
  const negocio = db.get('SELECT * FROM negocios WHERE id = ?', nid);
  if (!negocio) throw noEncontrado('Ese negocio no existe');
  const u = ctx.usuario;
  if (u.rol === 'admin') {
    if (!roles.includes('admin')) throw prohibido();
    return negocio;
  }
  if (u.negocio_id !== nid || !roles.includes(u.rol)) throw prohibido();
  return negocio;
}

// Páginas en las que este usuario puede publicar dentro del negocio.
function paginasPermitidas(usuario, negocioId) {
  if (usuario.rol === 'proveedor') {
    return db.all(
      `SELECT p.* FROM paginas p JOIN asignaciones a ON a.pagina_id = p.id
        WHERE a.usuario_id = ? AND p.negocio_id = ? AND p.activo = 1 ORDER BY p.nombre`,
      usuario.id, negocioId,
    );
  }
  return db.all('SELECT * FROM paginas WHERE negocio_id = ? AND activo = 1 ORDER BY nombre', negocioId);
}

function entero(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ErrorHttp(400, 'Dato inválido');
  return n;
}

function texto(v, max = 200) {
  return String(Array.isArray(v) ? v[0] : v ?? '').trim().slice(0, max);
}

function emailValido(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
}

module.exports = { requiereSesion, soloAdmin, negocioDeRuta, paginasPermitidas, entero, texto, emailValido };
