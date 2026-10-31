'use strict';
const crypto = require('node:crypto');
const { config } = require('./config');
const db = require('./db');

// ---------- Contraseñas (scrypt) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, sal, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

function verificarPassword(password, guardado) {
  try {
    const [alg, N, r, p, salB64, hashB64] = String(guardado).split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(hashB64, 'base64');
    const calculado = crypto.scryptSync(password, Buffer.from(salB64, 'base64'), esperado.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(esperado, calculado);
  } catch {
    return false;
  }
}

// Hash ficticio para que un correo inexistente tarde lo mismo que uno real.
const HASH_FICTICIO = hashPassword(crypto.randomBytes(12).toString('hex'));

function validarPasswordNueva(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (pw.length > 200) return 'La contraseña es demasiado larga.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'La contraseña debe combinar letras y números.';
  return null;
}

function passwordTemporal() {
  // Sin caracteres confusos (0/O, 1/l/I).
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += abc[b % abc.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

// ---------- Cifrado de tokens (AES-256-GCM) ----------
function clave() {
  return crypto.createHash('sha256').update(config.claveCifrado).digest();
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}
function descifrar(cadena) {
  if (!cadena) return null;
  const [v, iv, tag, datos] = cadena.split(':');
  if (v !== 'v1') throw new Error('Formato de cifrado desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8');
}

// ---------- Sesiones ----------
const COOKIE = 'pub_sesion';

function nuevaSesion(usuarioId = null) {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expira = new Date(Date.now() + config.sesionHoras * 3600e3).toISOString();
  db.run('INSERT INTO sesiones (id, usuario_id, csrf, expira) VALUES (?, ?, ?, ?)', id, usuarioId, csrf, expira);
  return { id, usuario_id: usuarioId, csrf, flash: null, expira };
}

function cookieSesion(id, maxAgeSeg) {
  const partes = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeg}`];
  if (config.cookieSegura) partes.push('Secure');
  return partes.join('; ');
}

function cargarSesion(ctx) {
  const id = ctx.cookies[COOKIE];
  let s = id ? db.get('SELECT * FROM sesiones WHERE id = ?', id) : null;
  if (s && s.expira < new Date().toISOString()) {
    db.run('DELETE FROM sesiones WHERE id = ?', s.id);
    s = null;
  }
  if (!s) {
    s = nuevaSesion(null);
    ctx.res.setHeader('Set-Cookie', cookieSesion(s.id, config.sesionHoras * 3600));
  } else if (s.usuario_id) {
    // Renovación por actividad (ventana deslizante).
    const expira = new Date(Date.now() + config.sesionHoras * 3600e3).toISOString();
    db.run('UPDATE sesiones SET expira = ? WHERE id = ?', expira, s.id);
  }
  ctx.sesion = s;
  ctx.usuario = null;
  if (s.usuario_id) {
    const u = db.get(
      `SELECT u.*, n.nombre AS negocio_nombre, n.activo AS negocio_activo
         FROM usuarios u LEFT JOIN negocios n ON n.id = u.negocio_id
        WHERE u.id = ?`,
      s.usuario_id,
    );
    if (u && u.activo && (u.rol === 'admin' || u.negocio_activo)) ctx.usuario = u;
    else {
      db.run('UPDATE sesiones SET usuario_id = NULL WHERE id = ?', s.id);
      s.usuario_id = null;
    }
  }
}

function iniciarSesion(ctx, usuarioId) {
  // Se reemplaza la sesión anónima por una nueva (evita fijación de sesión).
  db.run('DELETE FROM sesiones WHERE id = ?', ctx.sesion.id);
  const s = nuevaSesion(usuarioId);
  ctx.res.setHeader('Set-Cookie', cookieSesion(s.id, config.sesionHoras * 3600));
  ctx.sesion = s;
}

function cerrarSesion(ctx) {
  db.run('DELETE FROM sesiones WHERE id = ?', ctx.sesion.id);
  ctx.res.setHeader('Set-Cookie', cookieSesion('', 0));
}

function cerrarSesionesDeUsuario(usuarioId, exceptoId = null) {
  db.run('DELETE FROM sesiones WHERE usuario_id = ? AND id IS NOT ?', usuarioId, exceptoId);
}

function flash(ctx, tipo, mensaje) {
  const lista = ctx.sesion.flash ? JSON.parse(ctx.sesion.flash) : [];
  lista.push({ tipo, mensaje });
  ctx.sesion.flash = JSON.stringify(lista);
  db.run('UPDATE sesiones SET flash = ? WHERE id = ?', ctx.sesion.flash, ctx.sesion.id);
}
function tomarFlash(ctx) {
  if (!ctx.sesion.flash) return [];
  const lista = JSON.parse(ctx.sesion.flash);
  ctx.sesion.flash = null;
  db.run('UPDATE sesiones SET flash = NULL WHERE id = ?', ctx.sesion.id);
  return lista;
}

function csrfValido(ctx, recibido) {
  if (typeof recibido !== 'string' || !ctx.sesion) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(ctx.sesion.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Límite de intentos (memoria) ----------
const intentos = new Map();
function limitar(clave, max, ventanaMin) {
  const ahora = Date.now();
  const lista = (intentos.get(clave) || []).filter((t) => ahora - t < ventanaMin * 60e3);
  intentos.set(clave, lista);
  return lista.length >= max;
}
function registrarIntento(clave) {
  const lista = intentos.get(clave) || [];
  lista.push(Date.now());
  intentos.set(clave, lista);
}
function limpiarIntentos(clave) {
  intentos.delete(clave);
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of intentos) if (!v.some((t) => ahora - t < 3600e3)) intentos.delete(k);
}, 600e3).unref();

module.exports = {
  hashPassword, verificarPassword, HASH_FICTICIO, validarPasswordNueva, passwordTemporal,
  cifrar, descifrar,
  cargarSesion, iniciarSesion, cerrarSesion, cerrarSesionesDeUsuario, flash, tomarFlash, csrfValido,
  limitar, registrarIntento, limpiarIntentos,
};
