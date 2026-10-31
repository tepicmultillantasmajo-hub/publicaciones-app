'use strict';
const db = require('./db');

function registrar(ctx, accion, { negocioId = null, detalle = null, usuarioId } = {}) {
  db.run(
    'INSERT INTO bitacora (negocio_id, usuario_id, accion, detalle, ip) VALUES (?, ?, ?, ?, ?)',
    negocioId ?? (ctx && ctx.usuario ? ctx.usuario.negocio_id : null),
    usuarioId !== undefined ? usuarioId : ctx && ctx.usuario ? ctx.usuario.id : null,
    accion,
    detalle ? JSON.stringify(detalle) : null,
    ctx ? ctx.ip : 'sistema',
  );
}

const ACCIONES = {
  login: 'Inició sesión',
  login_fallido: 'Intento de acceso fallido',
  logout: 'Cerró sesión',
  password_cambiada: 'Cambió su contraseña',
  password_restablecida: 'Restableció la contraseña de un usuario',
  negocio_creado: 'Creó el negocio',
  negocio_actualizado: 'Actualizó el negocio',
  token_actualizado: 'Actualizó el token de Meta',
  pagina_creada: 'Agregó una página',
  pagina_actualizada: 'Actualizó una página',
  usuario_creado: 'Creó un usuario',
  usuario_actualizado: 'Actualizó un usuario',
  publicacion_creada: 'Subió una publicación',
  publicacion_aprobada: 'Aprobó una publicación',
  publicacion_rechazada: 'Rechazó una publicación',
  publicacion_publicada: 'Publicación completada',
  publicacion_error: 'Publicación con error',
  publicacion_reintentada: 'Reintentó una publicación',
};

module.exports = { registrar, ACCIONES };
