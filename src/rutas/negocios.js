'use strict';
const fs = require('node:fs');
const db = require('../db');
const { html, fecha } = require('../plantilla');
const { pagina, csrfInput } = require('../layout');
const { enviar, redirigir, ErrorHttp } = require('../http');
const seg = require('../seguridad');
const { registrar } = require('../auditoria');
const { requiereSesion, soloAdmin, negocioDeRuta, texto, emailValido } = require('../acceso');

// Pantalla que muestra una contraseña temporal UNA sola vez.
function vistaCredenciales(ctx, { titulo, nombre, email, password, volver, negocio = null }) {
  return pagina(ctx, {
    titulo, negocio,
    contenido: html`
<div class="encabezado"><h1>${titulo}</h1></div>
<section class="tarjeta credenciales">
  <p>Comparte estos datos con <strong>${nombre}</strong> por un medio privado. La contraseña <strong>no se volverá a mostrar</strong>; al entrar por primera vez se le pedirá cambiarla.</p>
  <dl class="datos">
    <dt>Dirección</dt><dd><code>${ctx.origen}/login</code></dd>
    <dt>Correo</dt><dd><code>${email}</code></dd>
    <dt>Contraseña temporal</dt><dd><code class="grande" data-copiable>${password}</code></dd>
  </dl>
  <div class="acciones">
    <button type="button" class="boton" data-copiar="Acceso: ${ctx.origen}/login&#10;Correo: ${email}&#10;Contraseña temporal: ${password}">Copiar datos</button>
    <a class="boton primario" href="${volver}">Listo</a>
  </div>
</section>`,
  });
}

function crearUsuario({ negocioId, nombre, email, rol, requiereAprobacion = false }) {
  if (!nombre) throw new ErrorHttp(400, 'Escribe el nombre.');
  if (!emailValido(email)) throw new ErrorHttp(400, 'El correo no es válido.');
  if (db.get('SELECT 1 AS x FROM usuarios WHERE email = ?', email)) {
    throw new ErrorHttp(400, `Ya existe un usuario con el correo ${email}.`);
  }
  const password = seg.passwordTemporal();
  const r = db.run(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash, rol, requiere_aprobacion, debe_cambiar_password)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    negocioId, nombre, email, seg.hashPassword(password), rol, requiereAprobacion,
  );
  return { id: Number(r.lastInsertRowid), password };
}

function registrarRutas(r) {
  r.get('/negocios', (ctx) => {
    if (!requiereSesion(ctx)) return;
    soloAdmin(ctx);
    enviar(ctx.res, 200, vistaNegocios(ctx));
  });

  r.post('/negocios', (ctx) => {
    if (!requiereSesion(ctx)) return;
    soloAdmin(ctx);
    const nombre = texto(ctx.form.nombre, 120);
    const duenoNombre = texto(ctx.form.dueno_nombre, 120);
    const duenoEmail = texto(ctx.form.dueno_email, 200).toLowerCase();
    try {
      if (!nombre) throw new ErrorHttp(400, 'Escribe el nombre del negocio.');
      if ((duenoNombre || duenoEmail) && !(duenoNombre && duenoEmail)) {
        throw new ErrorHttp(400, 'Para crear al dueño escribe su nombre y su correo (o deja ambos vacíos).');
      }
      const resultado = db.transaccion(() => {
        const n = db.run('INSERT INTO negocios (nombre) VALUES (?)', nombre);
        const negocioId = Number(n.lastInsertRowid);
        let dueno = null;
        if (duenoEmail) dueno = crearUsuario({ negocioId, nombre: duenoNombre, email: duenoEmail, rol: 'dueno' });
        return { negocioId, dueno };
      });
      registrar(ctx, 'negocio_creado', { negocioId: resultado.negocioId, detalle: { nombre } });
      if (resultado.dueno) {
        registrar(ctx, 'usuario_creado', {
          negocioId: resultado.negocioId, detalle: { nombre: duenoNombre, email: duenoEmail, rol: 'dueno' },
        });
        return enviar(ctx.res, 200, vistaCredenciales(ctx, {
          titulo: 'Negocio creado', nombre: duenoNombre, email: duenoEmail, password: resultado.dueno.password,
          volver: `/negocios/${resultado.negocioId}/ajustes`,
        }));
      }
      seg.flash(ctx, 'exito', `Negocio "${nombre}" creado. Ahora configura su token de Meta y sus páginas.`);
      redirigir(ctx.res, `/negocios/${resultado.negocioId}/ajustes`);
    } catch (e) {
      if (!(e instanceof ErrorHttp)) throw e;
      enviar(ctx.res, 400, vistaNegocios(ctx, { error: e.message, valores: ctx.form }));
    }
  });

  r.get('/negocios/:nid/ajustes', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    enviar(ctx.res, 200, vistaAjustes(ctx, negocio));
  });

  r.post('/negocios/:nid/ajustes', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    const nombre = texto(ctx.form.nombre, 120);
    if (!nombre) return enviar(ctx.res, 400, vistaAjustes(ctx, negocio, 'El nombre no puede quedar vacío.'));
    const activo = ctx.form.activo === '1';
    db.run('UPDATE negocios SET nombre = ?, activo = ? WHERE id = ?', nombre, activo, negocio.id);
    if (!activo && negocio.activo) {
      // Al desactivar, se cierran las sesiones de todo su personal.
      db.run('DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = ?)', negocio.id);
    }
    registrar(ctx, 'negocio_actualizado', { negocioId: negocio.id, detalle: { nombre, activo } });
    seg.flash(ctx, 'exito', 'Cambios guardados.');
    redirigir(ctx.res, `/negocios/${negocio.id}/ajustes`);
  });

  r.post('/negocios/:nid/token', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    const token = String(ctx.form.token || '').trim();
    if (ctx.form.quitar === '1') {
      db.run('UPDATE negocios SET meta_token_cifrado = NULL WHERE id = ?', negocio.id);
      registrar(ctx, 'token_actualizado', { negocioId: negocio.id, detalle: { accion: 'quitado' } });
      seg.flash(ctx, 'exito', 'Token eliminado. Las publicaciones de este negocio fallarán hasta que configures uno nuevo.');
      return redirigir(ctx.res, `/negocios/${negocio.id}/ajustes`);
    }
    if (token.length < 50 || /\s/.test(token)) {
      return enviar(ctx.res, 400, vistaAjustes(ctx, negocio, 'El token no parece válido: debe ser una sola cadena larga, sin espacios.'));
    }
    db.run('UPDATE negocios SET meta_token_cifrado = ? WHERE id = ?', seg.cifrar(token), negocio.id);
    registrar(ctx, 'token_actualizado', { negocioId: negocio.id, detalle: { accion: 'guardado', termina_en: token.slice(-4) } });
    seg.flash(ctx, 'exito', 'Token guardado y cifrado. Verifica cada página desde la sección Páginas.');
    redirigir(ctx.res, `/negocios/${negocio.id}/ajustes`);
  });

  r.post('/negocios/:nid/eliminar', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    if (texto(ctx.form.confirmar, 120) !== negocio.nombre) {
      return enviar(ctx.res, 400, vistaAjustes(ctx, negocio, `Para eliminar, escribe el nombre exacto del negocio: ${negocio.nombre}`));
    }
    const activas = db.get(
      "SELECT COUNT(*) AS n FROM publicaciones WHERE negocio_id = ? AND estado IN ('en_cola','publicando')", negocio.id).n;
    if (activas) {
      return enviar(ctx.res, 400, vistaAjustes(ctx, negocio,
        'Este negocio tiene publicaciones en proceso. Espera a que terminen y vuelve a intentarlo.'));
    }
    const conteo = conteoNegocio(negocio.id);
    const archivos = db.all('SELECT ruta FROM subidas WHERE negocio_id = ?', negocio.id);
    db.transaccion(() => {
      // Las sesiones, usuarios, páginas, asignaciones y publicaciones se borran en cascada.
      db.run('DELETE FROM negocios WHERE id = ?', negocio.id);
    });
    for (const a of archivos) fs.rm(a.ruta, { force: true }, () => {});
    registrar(ctx, 'negocio_eliminado', { negocioId: null, detalle: { nombre: negocio.nombre, ...conteo } });
    seg.flash(ctx, 'exito', `Negocio "${negocio.nombre}" eliminado.`);
    redirigir(ctx.res, '/negocios');
  });
}

function conteoNegocio(id) {
  return db.get(`SELECT
    (SELECT COUNT(*) FROM paginas WHERE negocio_id = ?) AS paginas,
    (SELECT COUNT(*) FROM usuarios WHERE negocio_id = ?) AS usuarios,
    (SELECT COUNT(*) FROM publicaciones WHERE negocio_id = ?) AS publicaciones`, id, id, id);
}

function vistaNegocios(ctx, { error = null, valores = {} } = {}) {
  const negocios = db.all(`
    SELECT n.*,
      (SELECT COUNT(*) FROM paginas p WHERE p.negocio_id = n.id AND p.activo = 1) AS paginas,
      (SELECT COUNT(*) FROM usuarios u WHERE u.negocio_id = n.id AND u.activo = 1) AS usuarios,
      (SELECT COUNT(*) FROM publicaciones x WHERE x.negocio_id = n.id AND x.estado = 'pendiente') AS pendientes,
      (SELECT COUNT(*) FROM publicaciones x WHERE x.negocio_id = n.id AND x.estado = 'error') AS errores,
      (SELECT MAX(creado) FROM publicaciones x WHERE x.negocio_id = n.id) AS ultima
    FROM negocios n ORDER BY n.activo DESC, n.nombre`);
  return pagina(ctx, {
    titulo: 'Negocios', ancho: true,
    contenido: html`
<div class="encabezado"><h1>Negocios</h1><p class="sutil">Cada negocio tiene sus propias páginas, equipo y token de Meta.</p></div>
${negocios.length ? html`
<div class="tabla-envoltura"><table class="tabla">
  <thead><tr><th>Negocio</th><th>Páginas</th><th>Usuarios</th><th>Token Meta</th><th>Pendientes</th><th>Última publicación</th><th></th></tr></thead>
  <tbody>${negocios.map((n) => html`
    <tr class="${n.activo ? '' : 'inactivo'}">
      <td><a href="/negocios/${n.id}/publicaciones"><strong>${n.nombre}</strong></a>${n.activo ? '' : html` <span class="insignia gris">Desactivado</span>`}</td>
      <td>${n.paginas}</td><td>${n.usuarios}</td>
      <td>${n.meta_token_cifrado ? html`<span class="insignia verde">Configurado</span>` : html`<span class="insignia rojo">Falta</span>`}</td>
      <td>${n.pendientes ? html`<span class="insignia amarillo">${n.pendientes}</span>` : '0'}${n.errores ? html` <span class="insignia rojo" title="Con error">${n.errores} error</span>` : ''}</td>
      <td>${n.ultima ? fecha(n.ultima) : '—'}</td>
      <td class="derecha"><a class="boton chico" href="/negocios/${n.id}/ajustes">Ajustes</a></td>
    </tr>`)}
  </tbody></table></div>` : html`<div class="vacio">Aún no hay negocios. Crea el primero abajo.</div>`}

<section class="tarjeta">
  <h2>Nuevo negocio</h2>
  ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
  <form method="post" action="/negocios" class="formulario rejilla tres">
    ${csrfInput(ctx)}
    <label>Nombre del negocio<input name="nombre" value="${valores.nombre || ''}" maxlength="120" required></label>
    <label>Nombre del dueño <small>(opcional)</small><input name="dueno_nombre" value="${valores.dueno_nombre || ''}" maxlength="120"></label>
    <label>Correo del dueño <small>(opcional)</small><input type="email" name="dueno_email" value="${valores.dueno_email || ''}" maxlength="200"></label>
    <div class="fila-completa"><button type="submit" class="boton primario">Crear negocio</button></div>
  </form>
</section>`,
  });
}

function vistaAjustes(ctx, negocio, error = null) {
  return pagina(ctx, {
    titulo: `Ajustes · ${negocio.nombre}`, negocio,
    contenido: html`
<div class="encabezado"><h1>Ajustes del negocio</h1></div>
${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
<div class="rejilla dos">
  <section class="tarjeta">
    <h2>Datos generales</h2>
    <form method="post" action="/negocios/${negocio.id}/ajustes" class="formulario">
      ${csrfInput(ctx)}
      <label>Nombre<input name="nombre" value="${negocio.nombre}" maxlength="120" required></label>
      <label class="casilla"><input type="checkbox" name="activo" value="1" ${negocio.activo ? 'checked' : ''}>
        Negocio activo <small>Si lo desactivas, nadie de su equipo podrá entrar ni publicar.</small></label>
      <button type="submit" class="boton primario">Guardar</button>
    </form>
    <p class="sutil">Creado el ${fecha(negocio.creado)}.</p>
  </section>
  <section class="tarjeta">
    <h2>Token de Meta</h2>
    <p>Estado: ${negocio.meta_token_cifrado
      ? html`<span class="insignia verde">Configurado y cifrado</span>`
      : html`<span class="insignia rojo">Sin configurar</span>`}</p>
    <p class="sutil">Pega el token del <strong>usuario del sistema</strong> del portafolio de este negocio, con acceso a sus páginas e Instagram. Por seguridad nunca se vuelve a mostrar; solo se puede reemplazar.</p>
    <form method="post" action="/negocios/${negocio.id}/token" class="formulario">
      ${csrfInput(ctx)}
      <label>${negocio.meta_token_cifrado ? 'Reemplazar token' : 'Token'}
        <textarea name="token" rows="3" autocomplete="off" spellcheck="false" placeholder="EAAG…" required></textarea></label>
      <button type="submit" class="boton primario">Guardar token</button>
    </form>
    ${negocio.meta_token_cifrado ? html`
    <form method="post" action="/negocios/${negocio.id}/token" class="en-linea" data-confirmar="¿Quitar el token? Las publicaciones de este negocio dejarán de salir.">
      ${csrfInput(ctx)}<input type="hidden" name="quitar" value="1">
      <button type="submit" class="boton peligro chico">Quitar token</button>
    </form>` : ''}
  </section>
</div>
${(() => {
  const c = conteoNegocio(negocio.id);
  return html`
<section class="tarjeta zona-peligro">
  <h2>Eliminar negocio</h2>
  <p>Se borrarán <strong>definitivamente</strong> de la app: ${c.paginas} página(s), ${c.usuarios} usuario(s) y ${c.publicaciones} publicación(es) con su historial. No se puede deshacer.</p>
  <p class="sutil">Lo que ya se publicó en Facebook e Instagram <strong>no</strong> se borra de las redes. Si solo quieres pausarlo, mejor desmarca "Negocio activo".</p>
  <form method="post" action="/negocios/${negocio.id}/eliminar" class="formulario" data-confirmar="¿Eliminar definitivamente el negocio ${negocio.nombre}?">
    ${csrfInput(ctx)}
    <label>Para confirmar, escribe el nombre exacto: <code>${negocio.nombre}</code>
      <input name="confirmar" autocomplete="off" required></label>
    <button type="submit" class="boton peligro">Eliminar negocio</button>
  </form>
</section>`;
})()}`,
  });
}

module.exports = { registrarRutas, crearUsuario, vistaCredenciales };
