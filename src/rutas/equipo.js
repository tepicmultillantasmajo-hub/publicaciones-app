'use strict';
const db = require('../db');
const { html, hace, ROLES } = require('../plantilla');
const { pagina, csrfInput } = require('../layout');
const { enviar, redirigir, noEncontrado, prohibido, ErrorHttp } = require('../http');
const seg = require('../seguridad');
const { registrar } = require('../auditoria');
const { requiereSesion, negocioDeRuta, entero, texto, emailValido } = require('../acceso');
const { crearUsuario, vistaCredenciales } = require('./negocios');

function puedeGestionar(actor, objetivo) {
  if (actor.id === objetivo.id) return false; // lo propio se cambia en "Mi cuenta"
  if (actor.rol === 'admin') return true;
  return actor.rol === 'dueno' && objetivo.rol === 'proveedor' && objetivo.negocio_id === actor.negocio_id;
}

function idsPaginas(form, negocioId) {
  const valores = [].concat(form.paginas || []).map(Number).filter(Number.isInteger);
  if (!valores.length) return [];
  const validas = new Set(db.all('SELECT id FROM paginas WHERE negocio_id = ?', negocioId).map((p) => p.id));
  return [...new Set(valores)].filter((id) => validas.has(id));
}

function guardarAsignaciones(usuarioId, ids) {
  db.run('DELETE FROM asignaciones WHERE usuario_id = ?', usuarioId);
  for (const id of ids) db.run('INSERT INTO asignaciones (usuario_id, pagina_id) VALUES (?, ?)', usuarioId, id);
}

function registrarRutas(r) {
  r.get('/negocios/:nid/equipo', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    enviar(ctx.res, 200, vistaEquipo(ctx, negocio));
  });

  r.post('/negocios/:nid/equipo', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const nombre = texto(ctx.form.nombre, 120);
    const email = texto(ctx.form.email, 200).toLowerCase();
    const rol = ctx.usuario.rol === 'admin' && ctx.form.rol === 'dueno' ? 'dueno' : 'proveedor';
    const requiereAprobacion = rol === 'proveedor' && ctx.form.requiere_aprobacion === '1';
    try {
      const paginas = rol === 'proveedor' ? idsPaginas(ctx.form, negocio.id) : [];
      const nuevo = db.transaccion(() => {
        const u = crearUsuario({ negocioId: negocio.id, nombre, email, rol, requiereAprobacion });
        guardarAsignaciones(u.id, paginas);
        return u;
      });
      registrar(ctx, 'usuario_creado', {
        negocioId: negocio.id, detalle: { nombre, email, rol, requiere_aprobacion: requiereAprobacion, paginas },
      });
      enviar(ctx.res, 200, vistaCredenciales(ctx, {
        titulo: rol === 'dueno' ? 'Dueño creado' : 'Proveedor creado',
        nombre, email, password: nuevo.password, volver: `/negocios/${negocio.id}/equipo`, negocio,
      }));
    } catch (e) {
      if (!(e instanceof ErrorHttp)) throw e;
      enviar(ctx.res, 400, vistaEquipo(ctx, negocio, { error: e.message, valores: ctx.form }));
    }
  });

  r.get('/negocios/:nid/equipo/:uid', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const u = cargarObjetivo(ctx, negocio);
    enviar(ctx.res, 200, vistaUsuario(ctx, negocio, u));
  });

  r.post('/negocios/:nid/equipo/:uid', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const u = cargarObjetivo(ctx, negocio);
    const nombre = texto(ctx.form.nombre, 120);
    const email = texto(ctx.form.email, 200).toLowerCase();
    const activo = ctx.form.activo === '1';
    const requiereAprobacion = u.rol === 'proveedor' && ctx.form.requiere_aprobacion === '1';
    let error = null;
    if (!nombre) error = 'El nombre no puede quedar vacío.';
    else if (!emailValido(email)) error = 'El correo no es válido.';
    else if (email !== u.email && db.get('SELECT 1 AS x FROM usuarios WHERE email = ?', email)) error = `Ya existe un usuario con el correo ${email}.`;
    if (error) return enviar(ctx.res, 400, vistaUsuario(ctx, negocio, { ...u, nombre, email, activo, requiere_aprobacion: requiereAprobacion }, error));

    const paginas = u.rol === 'proveedor' ? idsPaginas(ctx.form, negocio.id) : [];
    db.transaccion(() => {
      db.run('UPDATE usuarios SET nombre = ?, email = ?, activo = ?, requiere_aprobacion = ? WHERE id = ?',
        nombre, email, activo, requiereAprobacion, u.id);
      if (u.rol === 'proveedor') guardarAsignaciones(u.id, paginas);
    });
    if (!activo) seg.cerrarSesionesDeUsuario(u.id);
    registrar(ctx, 'usuario_actualizado', {
      negocioId: negocio.id,
      detalle: { usuario: u.id, nombre, email, activo, requiere_aprobacion: requiereAprobacion, paginas },
    });
    seg.flash(ctx, 'exito', activo ? 'Cambios guardados.' : `${nombre} quedó desactivado y se cerraron sus sesiones.`);
    redirigir(ctx.res, `/negocios/${negocio.id}/equipo`);
  });

  r.post('/negocios/:nid/equipo/:uid/restablecer', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const u = cargarObjetivo(ctx, negocio);
    const password = seg.passwordTemporal();
    db.run('UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 1 WHERE id = ?', seg.hashPassword(password), u.id);
    seg.cerrarSesionesDeUsuario(u.id);
    registrar(ctx, 'password_restablecida', { negocioId: negocio.id, detalle: { usuario: u.id, email: u.email } });
    enviar(ctx.res, 200, vistaCredenciales(ctx, {
      titulo: 'Contraseña restablecida', nombre: u.nombre, email: u.email, password,
      volver: `/negocios/${negocio.id}/equipo`, negocio,
    }));
  });
}

function cargarObjetivo(ctx, negocio) {
  const u = db.get('SELECT * FROM usuarios WHERE id = ? AND negocio_id = ?', entero(ctx.params.uid), negocio.id);
  if (!u) throw noEncontrado('Ese usuario no existe');
  if (!puedeGestionar(ctx.usuario, u)) throw prohibido('No puedes modificar a este usuario');
  return u;
}

function casillasPaginas(paginas, marcadas) {
  if (!paginas.length) return html`<p class="sutil">Este negocio aún no tiene páginas activas.</p>`;
  return html`<div class="casillas">${paginas.map((p) => html`
    <label class="casilla"><input type="checkbox" name="paginas" value="${p.id}" ${marcadas.has(p.id) ? 'checked' : ''}> ${p.nombre}</label>`)}
  </div>`;
}

function vistaEquipo(ctx, negocio, { error = null, valores = {} } = {}) {
  const esAdmin = ctx.usuario.rol === 'admin';
  const usuarios = db.all(`
    SELECT u.*,
      (SELECT GROUP_CONCAT(p.nombre, ', ') FROM asignaciones a JOIN paginas p ON p.id = a.pagina_id
        WHERE a.usuario_id = u.id AND p.activo = 1) AS paginas,
      (SELECT COUNT(*) FROM publicaciones x WHERE x.usuario_id = u.id) AS publicaciones
    FROM usuarios u WHERE u.negocio_id = ?
    ORDER BY u.activo DESC, CASE u.rol WHEN 'dueno' THEN 0 ELSE 1 END, u.nombre`, negocio.id);
  const paginas = db.all('SELECT id, nombre FROM paginas WHERE negocio_id = ? AND activo = 1 ORDER BY nombre', negocio.id);
  const marcadas = new Set([].concat(valores.paginas || []).map(Number));
  return pagina(ctx, {
    titulo: `Equipo · ${negocio.nombre}`, negocio, ancho: true,
    contenido: html`
<div class="encabezado"><h1>Equipo</h1><p class="sutil">Cada persona entra con su propio usuario y solo ve las páginas que le asignes.</p></div>
${usuarios.length ? html`
<div class="tabla-envoltura"><table class="tabla">
  <thead><tr><th>Nombre</th><th>Rol</th><th>Páginas</th><th>Aprobación</th><th>Último acceso</th><th>Publicaciones</th><th></th></tr></thead>
  <tbody>${usuarios.map((u) => html`
    <tr class="${u.activo ? '' : 'inactivo'}">
      <td><strong>${u.nombre}</strong><br><small class="sutil">${u.email}</small>${u.activo ? '' : html` <span class="insignia gris">Desactivado</span>`}</td>
      <td>${ROLES[u.rol]}</td>
      <td>${u.rol === 'dueno' ? html`<span class="sutil">Todas</span>` : u.paginas || html`<span class="insignia rojo">Ninguna</span>`}</td>
      <td>${u.rol === 'dueno' ? '—' : u.requiere_aprobacion ? html`<span class="insignia amarillo">Requiere</span>` : html`<span class="insignia verde">Publica directo</span>`}</td>
      <td>${u.ultimo_acceso ? hace(u.ultimo_acceso) : html`<span class="sutil">Nunca</span>`}</td>
      <td>${u.publicaciones}</td>
      <td class="derecha">${puedeGestionar(ctx.usuario, u) ? html`<a class="boton chico" href="/negocios/${negocio.id}/equipo/${u.id}">Editar</a>` : ''}</td>
    </tr>`)}
  </tbody></table></div>` : html`<div class="vacio">Aún no hay nadie en el equipo.</div>`}

<section class="tarjeta">
  <h2>Agregar persona</h2>
  ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
  <form method="post" action="/negocios/${negocio.id}/equipo" class="formulario">
    ${csrfInput(ctx)}
    <div class="rejilla ${esAdmin ? 'tres' : 'dos'}">
      <label>Nombre<input name="nombre" value="${valores.nombre || ''}" maxlength="120" required></label>
      <label>Correo<input type="email" name="email" value="${valores.email || ''}" maxlength="200" required></label>
      ${esAdmin ? html`<label>Rol<select name="rol" data-rol>
        <option value="proveedor" ${valores.rol !== 'dueno' ? 'selected' : ''}>Proveedor</option>
        <option value="dueno" ${valores.rol === 'dueno' ? 'selected' : ''}>Dueño del negocio</option>
      </select></label>` : ''}
    </div>
    <div data-solo-proveedor>
      <fieldset><legend>Páginas en las que puede publicar</legend>${casillasPaginas(paginas, marcadas)}</fieldset>
      <label class="casilla"><input type="checkbox" name="requiere_aprobacion" value="1" ${valores.requiere_aprobacion === '1' ? 'checked' : ''}>
        Sus publicaciones requieren aprobación <small>Si no lo marcas, lo que suba se publica de inmediato.</small></label>
    </div>
    <button type="submit" class="boton primario">Crear usuario</button>
  </form>
</section>`,
  });
}

function vistaUsuario(ctx, negocio, u, error = null) {
  const paginas = db.all('SELECT id, nombre FROM paginas WHERE negocio_id = ? AND activo = 1 ORDER BY nombre', negocio.id);
  const marcadas = new Set(db.all('SELECT pagina_id FROM asignaciones WHERE usuario_id = ?', u.id).map((a) => a.pagina_id));
  return pagina(ctx, {
    titulo: `Editar ${u.nombre}`, negocio,
    contenido: html`
<div class="encabezado"><a class="volver" href="/negocios/${negocio.id}/equipo">← Equipo</a><h1>${u.nombre}</h1><p class="sutil">${ROLES[u.rol]}</p></div>
<div class="rejilla dos">
  <section class="tarjeta">
    ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
    <form method="post" action="/negocios/${negocio.id}/equipo/${u.id}" class="formulario">
      ${csrfInput(ctx)}
      <label>Nombre<input name="nombre" value="${u.nombre}" maxlength="120" required></label>
      <label>Correo<input type="email" name="email" value="${u.email}" maxlength="200" required></label>
      ${u.rol === 'proveedor' ? html`
      <fieldset><legend>Páginas en las que puede publicar</legend>${casillasPaginas(paginas, marcadas)}</fieldset>
      <label class="casilla"><input type="checkbox" name="requiere_aprobacion" value="1" ${u.requiere_aprobacion ? 'checked' : ''}>
        Sus publicaciones requieren aprobación</label>` : ''}
      <label class="casilla"><input type="checkbox" name="activo" value="1" ${u.activo ? 'checked' : ''}>
        Acceso activo <small>Al desactivarlo se cierra su sesión de inmediato. Su historial se conserva.</small></label>
      <button type="submit" class="boton primario">Guardar cambios</button>
    </form>
  </section>
  <section class="tarjeta">
    <h2>Contraseña</h2>
    <p class="sutil">Si olvidó su contraseña, genera una temporal. Se cerrarán sus sesiones abiertas.</p>
    <form method="post" action="/negocios/${negocio.id}/equipo/${u.id}/restablecer" data-confirmar="¿Generar una contraseña temporal nueva para ${u.nombre}?">
      ${csrfInput(ctx)}<button type="submit" class="boton">Restablecer contraseña</button>
    </form>
  </section>
</div>`,
  });
}

module.exports = { registrarRutas };
