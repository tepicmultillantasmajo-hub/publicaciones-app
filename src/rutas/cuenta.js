'use strict';
const db = require('../db');
const { html } = require('../plantilla');
const { pagina, csrfInput } = require('../layout');
const { enviar, redirigir } = require('../http');
const { config } = require('../config');
const { ROLES } = require('../plantilla');
const seg = require('../seguridad');
const { registrar } = require('../auditoria');
const { requiereSesion, texto } = require('../acceso');

function vistaLogin(ctx, { error = null, email = '' } = {}) {
  return pagina(ctx, {
    titulo: 'Iniciar sesión',
    contenido: html`
<section class="login">
  <div class="login-tarjeta">
    <div class="login-logo" aria-hidden="true"><img src="/static/icono.svg" alt="" width="44" height="44"></div>
    <h1>${config.nombreApp}</h1>
    <p class="sutil">Entra con el usuario que te asignaron.</p>
    ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
    <form method="post" action="/login" class="formulario">
      ${csrfInput(ctx)}
      <label>Correo
        <input type="email" name="email" value="${email}" autocomplete="username" required autofocus>
      </label>
      <label>Contraseña
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button type="submit" class="boton primario ancho-completo">Entrar</button>
    </form>
  </div>
</section>`,
  });
}

function registrarRutas(r) {
  r.get('/', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const u = ctx.usuario;
    if (u.rol === 'admin') return redirigir(ctx.res, '/negocios');
    if (u.rol === 'proveedor') return redirigir(ctx.res, `/negocios/${u.negocio_id}/publicar`);
    return redirigir(ctx.res, `/negocios/${u.negocio_id}/publicaciones`);
  });

  r.get('/login', (ctx) => {
    if (ctx.usuario) return redirigir(ctx.res, '/');
    enviar(ctx.res, 200, vistaLogin(ctx));
  });

  r.post('/login', (ctx) => {
    const email = texto(ctx.form.email, 200).toLowerCase();
    const password = String(ctx.form.password || '');
    const claveIp = `ip:${ctx.ip}`;
    const claveEmail = `email:${email}`;
    if (seg.limitar(claveIp, 20, 15) || seg.limitar(claveEmail, 5, 15)) {
      return enviar(ctx.res, 429, vistaLogin(ctx, {
        email, error: 'Demasiados intentos. Espera 15 minutos y vuelve a intentarlo.',
      }));
    }
    const u = db.get(
      `SELECT u.*, n.activo AS negocio_activo FROM usuarios u
         LEFT JOIN negocios n ON n.id = u.negocio_id WHERE u.email = ?`,
      email,
    );
    const correcta = seg.verificarPassword(password, u ? u.password_hash : seg.HASH_FICTICIO);
    if (!u || !correcta || !u.activo || (u.rol !== 'admin' && !u.negocio_activo)) {
      seg.registrarIntento(claveIp);
      seg.registrarIntento(claveEmail);
      if (u) registrar(ctx, 'login_fallido', { negocioId: u.negocio_id, usuarioId: u.id });
      const motivo = u && correcta && (!u.activo || !u.negocio_activo)
        ? 'Tu acceso está desactivado. Contacta al responsable del negocio.'
        : 'Correo o contraseña incorrectos.';
      return enviar(ctx.res, 401, vistaLogin(ctx, { email, error: motivo }));
    }
    seg.limpiarIntentos(claveEmail);
    seg.iniciarSesion(ctx, u.id);
    db.run("UPDATE usuarios SET ultimo_acceso = datetime('now') WHERE id = ?", u.id);
    registrar(ctx, 'login', { negocioId: u.negocio_id, usuarioId: u.id });
    redirigir(ctx.res, '/');
  });

  r.post('/salir', (ctx) => {
    if (ctx.usuario) registrar(ctx, 'logout');
    seg.cerrarSesion(ctx);
    redirigir(ctx.res, '/login');
  });

  r.get('/cuenta', (ctx) => {
    if (!requiereSesion(ctx)) return;
    enviar(ctx.res, 200, vistaCuenta(ctx));
  });

  r.post('/cuenta', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const u = ctx.usuario;
    const actual = String(ctx.form.actual || '');
    const nueva = String(ctx.form.nueva || '');
    const confirmar = String(ctx.form.confirmar || '');
    let error = null;
    if (!seg.verificarPassword(actual, u.password_hash)) error = 'La contraseña actual no es correcta.';
    else if (nueva !== confirmar) error = 'La nueva contraseña y su confirmación no coinciden.';
    else if (nueva === actual) error = 'La nueva contraseña debe ser distinta de la actual.';
    else error = seg.validarPasswordNueva(nueva);
    if (error) return enviar(ctx.res, 400, vistaCuenta(ctx, error));

    db.run('UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 0 WHERE id = ?', seg.hashPassword(nueva), u.id);
    seg.cerrarSesionesDeUsuario(u.id, ctx.sesion.id);
    registrar(ctx, 'password_cambiada');
    seg.flash(ctx, 'exito', 'Contraseña actualizada.');
    redirigir(ctx.res, u.debe_cambiar_password ? '/' : '/cuenta');
  });
}

function vistaCuenta(ctx, error = null) {
  const u = ctx.usuario;
  return pagina(ctx, {
    titulo: 'Mi cuenta',
    contenido: html`
<div class="encabezado"><h1>Mi cuenta</h1></div>
${u.debe_cambiar_password ? html`<div class="aviso info">Por seguridad, cambia la contraseña temporal que te dieron antes de continuar.</div>` : ''}
<div class="rejilla dos">
  <section class="tarjeta">
    <h2>Datos</h2>
    <dl class="datos">
      <dt>Nombre</dt><dd>${u.nombre}</dd>
      <dt>Correo</dt><dd>${u.email}</dd>
      <dt>Rol</dt><dd>${ROLES[u.rol]}</dd>
      ${u.negocio_nombre ? html`<dt>Negocio</dt><dd>${u.negocio_nombre}</dd>` : ''}
    </dl>
  </section>
  <section class="tarjeta">
    <h2>Cambiar contraseña</h2>
    ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
    <form method="post" action="/cuenta" class="formulario">
      ${csrfInput(ctx)}
      <label>Contraseña actual<input type="password" name="actual" autocomplete="current-password" required></label>
      <label>Nueva contraseña<input type="password" name="nueva" autocomplete="new-password" minlength="10" required>
        <small>Mínimo 10 caracteres, con letras y números.</small></label>
      <label>Confirmar nueva contraseña<input type="password" name="confirmar" autocomplete="new-password" minlength="10" required></label>
      <button type="submit" class="boton primario">Guardar contraseña</button>
    </form>
  </section>
</div>`,
  });
}

module.exports = { registrarRutas };
