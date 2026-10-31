'use strict';
const db = require('../db');
const { html } = require('../plantilla');
const { pagina, csrfInput } = require('../layout');
const { enviar, redirigir, noEncontrado } = require('../http');
const seg = require('../seguridad');
const { registrar } = require('../auditoria');
const { verificarPagina } = require('../meta');
const { requiereSesion, negocioDeRuta, entero, texto } = require('../acceso');

const ID_META = /^\d{5,25}$/;

function leerPagina(form) {
  const datos = {
    nombre: texto(form.nombre, 120),
    fb_page_id: texto(form.fb_page_id, 30),
    ig_user_id: texto(form.ig_user_id, 30),
  };
  let error = null;
  if (!datos.nombre) error = 'Escribe un nombre para la página.';
  else if (!ID_META.test(datos.fb_page_id)) error = 'El ID de la página de Facebook debe ser solo números.';
  else if (!ID_META.test(datos.ig_user_id)) error = 'El ID de la cuenta de Instagram debe ser solo números.';
  return { datos, error };
}

function registrarRutas(r) {
  r.get('/negocios/:nid/paginas', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    enviar(ctx.res, 200, vistaPaginas(ctx, negocio));
  });

  r.post('/negocios/:nid/paginas', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    const { datos, error } = leerPagina(ctx.form);
    if (error) return enviar(ctx.res, 400, vistaPaginas(ctx, negocio, { error, valores: datos }));
    db.run('INSERT INTO paginas (negocio_id, nombre, fb_page_id, ig_user_id) VALUES (?, ?, ?, ?)',
      negocio.id, datos.nombre, datos.fb_page_id, datos.ig_user_id);
    registrar(ctx, 'pagina_creada', { negocioId: negocio.id, detalle: datos });
    seg.flash(ctx, 'exito', `Página "${datos.nombre}" agregada. Usa "Verificar" para confirmar que el token tiene acceso.`);
    redirigir(ctx.res, `/negocios/${negocio.id}/paginas`);
  });

  r.get('/negocios/:nid/paginas/:pid', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    const p = db.get('SELECT * FROM paginas WHERE id = ? AND negocio_id = ?', entero(ctx.params.pid), negocio.id);
    if (!p) throw noEncontrado();
    enviar(ctx.res, 200, vistaEditar(ctx, negocio, p));
  });

  r.post('/negocios/:nid/paginas/:pid', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin']);
    const p = db.get('SELECT * FROM paginas WHERE id = ? AND negocio_id = ?', entero(ctx.params.pid), negocio.id);
    if (!p) throw noEncontrado();
    const { datos, error } = leerPagina(ctx.form);
    const activo = ctx.form.activo === '1';
    if (error) return enviar(ctx.res, 400, vistaEditar(ctx, negocio, { ...p, ...datos, activo }, error));
    db.run('UPDATE paginas SET nombre = ?, fb_page_id = ?, ig_user_id = ?, activo = ? WHERE id = ?',
      datos.nombre, datos.fb_page_id, datos.ig_user_id, activo, p.id);
    registrar(ctx, 'pagina_actualizada', { negocioId: negocio.id, detalle: { ...datos, activo } });
    seg.flash(ctx, 'exito', 'Página actualizada.');
    redirigir(ctx.res, `/negocios/${negocio.id}/paginas`);
  });

  r.post('/negocios/:nid/paginas/:pid/verificar', async (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const p = db.get('SELECT * FROM paginas WHERE id = ? AND negocio_id = ?', entero(ctx.params.pid), negocio.id);
    if (!p) throw noEncontrado();
    if (!negocio.meta_token_cifrado) {
      seg.flash(ctx, 'error', 'Este negocio aún no tiene token de Meta configurado.');
    } else {
      const res = await verificarPagina(seg.descifrar(negocio.meta_token_cifrado), p.fb_page_id, p.ig_user_id);
      seg.flash(ctx, res.ok ? 'exito' : 'error', `${p.nombre}: ${res.mensaje}`);
    }
    redirigir(ctx.res, `/negocios/${negocio.id}/paginas`);
  });
}

function vistaPaginas(ctx, negocio, { error = null, valores = {} } = {}) {
  const esAdmin = ctx.usuario.rol === 'admin';
  const paginas = db.all(`
    SELECT p.*, (SELECT COUNT(*) FROM asignaciones a JOIN usuarios u ON u.id = a.usuario_id
                  WHERE a.pagina_id = p.id AND u.activo = 1) AS proveedores,
                (SELECT COUNT(*) FROM publicaciones x WHERE x.pagina_id = p.id AND x.estado = 'publicada') AS publicadas
      FROM paginas p WHERE p.negocio_id = ? ORDER BY p.activo DESC, p.nombre`, negocio.id);
  return pagina(ctx, {
    titulo: `Páginas · ${negocio.nombre}`, negocio,
    contenido: html`
<div class="encabezado"><h1>Páginas</h1><p class="sutil">Cada página publica en su Facebook y en su Instagram vinculado (muro e historias).</p></div>
${paginas.length ? html`
<div class="tabla-envoltura"><table class="tabla">
  <thead><tr><th>Página</th><th>ID Facebook</th><th>ID Instagram</th><th>Con acceso</th><th>Publicadas</th><th></th></tr></thead>
  <tbody>${paginas.map((p) => html`
    <tr class="${p.activo ? '' : 'inactivo'}">
      <td><strong>${p.nombre}</strong>${p.activo ? '' : html` <span class="insignia gris">Desactivada</span>`}</td>
      <td><code>${p.fb_page_id}</code></td><td><code>${p.ig_user_id}</code></td>
      <td>${p.proveedores} proveedor(es)</td><td>${p.publicadas}</td>
      <td class="derecha acciones-fila">
        <form method="post" action="/negocios/${negocio.id}/paginas/${p.id}/verificar" class="en-linea" data-ocupado="Verificando…">
          ${csrfInput(ctx)}<button type="submit" class="boton chico">Verificar</button>
        </form>
        ${esAdmin ? html`<a class="boton chico" href="/negocios/${negocio.id}/paginas/${p.id}">Editar</a>` : ''}
      </td>
    </tr>`)}
  </tbody></table></div>` : html`<div class="vacio">Este negocio aún no tiene páginas.${esAdmin ? ' Agrega la primera abajo.' : ' El administrador debe darlas de alta.'}</div>`}

${esAdmin ? html`
<section class="tarjeta">
  <h2>Agregar página</h2>
  ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
  <form method="post" action="/negocios/${negocio.id}/paginas" class="formulario rejilla tres">
    ${csrfInput(ctx)}
    <label>Nombre<input name="nombre" value="${valores.nombre || ''}" maxlength="120" placeholder="Ej. Sucursal Centro" required></label>
    <label>ID de la página de Facebook<input name="fb_page_id" value="${valores.fb_page_id || ''}" inputmode="numeric" required></label>
    <label>ID de la cuenta de Instagram<input name="ig_user_id" value="${valores.ig_user_id || ''}" inputmode="numeric" required></label>
    <div class="fila-completa"><button type="submit" class="boton primario">Agregar página</button></div>
  </form>
</section>` : ''}`,
  });
}

function vistaEditar(ctx, negocio, p, error = null) {
  return pagina(ctx, {
    titulo: `Editar ${p.nombre}`, negocio,
    contenido: html`
<div class="encabezado"><a class="volver" href="/negocios/${negocio.id}/paginas">← Páginas</a><h1>Editar página</h1></div>
<section class="tarjeta angosta">
  ${error ? html`<div class="aviso error" role="alert">${error}</div>` : ''}
  <form method="post" action="/negocios/${negocio.id}/paginas/${p.id}" class="formulario">
    ${csrfInput(ctx)}
    <label>Nombre<input name="nombre" value="${p.nombre}" maxlength="120" required></label>
    <label>ID de la página de Facebook<input name="fb_page_id" value="${p.fb_page_id}" inputmode="numeric" required></label>
    <label>ID de la cuenta de Instagram<input name="ig_user_id" value="${p.ig_user_id}" inputmode="numeric" required></label>
    <label class="casilla"><input type="checkbox" name="activo" value="1" ${p.activo ? 'checked' : ''}>
      Página activa <small>Si la desactivas, nadie podrá publicar en ella.</small></label>
    <button type="submit" class="boton primario">Guardar</button>
  </form>
</section>`,
  });
}

module.exports = { registrarRutas };
