'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const { config } = require('../config');
const { html, fecha, hace, insigniaEstado, ESTADOS, miniatura, recortar } = require('../plantilla');
const { pagina, csrfInput, icono } = require('../layout');
const { enviar, enviarJson, redirigir, noEncontrado, prohibido, ErrorHttp } = require('../http');
const seg = require('../seguridad');
const { registrar } = require('../auditoria');
const cloudinary = require('../cloudinary');
const { despertarCola } = require('../cola');
const { requiereSesion, negocioDeRuta, paginasPermitidas, entero, texto } = require('../acceso');

const L = config.limites;
const POR_PAGINA = 24;

// ---------- Validación de archivos ----------
async function detectarTipo(ruta) {
  const fh = await fsp.open(ruta, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(12), 0, 12, 0);
    if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'imagen';
    if (bytesRead >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') return 'video';
    return null;
  } finally {
    await fh.close();
  }
}

function validarMedidas(tipo, m) {
  if (!m.ancho || !m.alto) return 'No se pudieron leer las medidas del archivo.';
  const proporcion = m.ancho / m.alto;
  if (tipo === 'video') {
    if (typeof m.duracion === 'number' && (m.duracion < L.videoMinSeg || m.duracion > L.videoMaxSeg)) {
      return `El video dura ${m.duracion.toFixed(1)} s. Debe durar entre ${L.videoMinSeg} y ${L.videoMaxSeg} segundos.`;
    }
    if (proporcion < 0.5 || proporcion > 0.6) {
      return `El video mide ${m.ancho}×${m.alto}. Debe ser vertical 9:16 (por ejemplo 1080×1920).`;
    }
  } else if (proporcion < 0.8 || proporcion > 1.91) {
    return `La imagen mide ${m.ancho}×${m.alto}. Para Instagram debe estar entre 4:5 vertical (1080×1350) y 1.91:1 horizontal.`;
  }
  return null;
}

function borrarSubida(s) {
  db.run('DELETE FROM subidas WHERE id = ?', s.id);
  fs.rm(s.ruta, { force: true }, () => {});
}

function limpiarSubidasViejas() {
  const viejas = db.all("SELECT * FROM subidas WHERE creado < datetime('now', '-2 hours')");
  for (const s of viejas) borrarSubida(s);
  // Archivos huérfanos (p. ej. tras un reinicio a mitad de subida).
  const dir = path.join(config.rutaDatos, 'subidas');
  const registradas = new Set(db.all('SELECT ruta FROM subidas').map((s) => path.basename(s.ruta)));
  for (const f of fs.readdirSync(dir)) {
    const ruta = path.join(dir, f);
    if (!registradas.has(f) && Date.now() - fs.statSync(ruta).mtimeMs > 2 * 3600e3) fs.rm(ruta, { force: true }, () => {});
  }
}

function cargarPublicacion(ctx, negocio) {
  const p = db.get(
    `SELECT x.*, p.nombre AS pagina_nombre, u.nombre AS autor, r.nombre AS revisor
       FROM publicaciones x
       JOIN paginas p ON p.id = x.pagina_id
       LEFT JOIN usuarios u ON u.id = x.usuario_id
       LEFT JOIN usuarios r ON r.id = x.revisado_por
      WHERE x.id = ? AND x.negocio_id = ?`,
    entero(ctx.params.id), negocio.id,
  );
  if (!p) throw noEncontrado('Esa publicación no existe');
  if (ctx.usuario.rol === 'proveedor' && p.usuario_id !== ctx.usuario.id) throw prohibido();
  return p;
}

const puedeRevisar = (u) => u.rol === 'admin' || u.rol === 'dueno';

function registrarRutas(r) {
  // ---------- Formulario de publicación ----------
  r.get('/negocios/:nid/publicar', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx);
    enviar(ctx.res, 200, vistaPublicar(ctx, negocio));
  });

  // ---------- Paso 1: recibir el archivo (cuerpo crudo, en streaming a disco) ----------
  r.post('/negocios/:nid/subir', async (ctx) => {
    if (!ctx.usuario) return enviarJson(ctx.res, 401, { error: 'Tu sesión terminó. Vuelve a entrar.' });
    const negocio = negocioDeRuta(ctx);
    if (!paginasPermitidas(ctx.usuario, negocio.id).length) throw prohibido('No tienes páginas asignadas.');

    const tipoDeclarado = String(ctx.req.headers['content-type'] || '').split(';')[0].trim();
    const permitido = { 'image/jpeg': 'imagen', 'video/mp4': 'video', 'video/quicktime': 'video' }[tipoDeclarado];
    if (!permitido) throw new ErrorHttp(415, 'Formato no permitido. Usa imagen JPG o video MP4/MOV.');
    const limite = (permitido === 'video' ? L.videoMB : L.imagenMB) * 1024 * 1024;
    const declarado = Number(ctx.req.headers['content-length'] || 0);
    if (declarado > limite) {
      throw new ErrorHttp(413, `El archivo pesa más de ${permitido === 'video' ? L.videoMB : L.imagenMB} MB.`);
    }

    const id = crypto.randomBytes(16).toString('hex');
    const ruta = path.join(config.rutaDatos, 'subidas', `${id}.tmp`);
    let total = 0;
    try {
      await new Promise((resolve, reject) => {
        const destino = fs.createWriteStream(ruta, { flags: 'wx' });
        ctx.req.on('data', (c) => {
          total += c.length;
          if (total > limite) {
            ctx.req.unpipe(destino);
            destino.destroy();
            reject(new ErrorHttp(413, 'El archivo supera el tamaño permitido.'));
          }
        });
        ctx.req.on('aborted', () => reject(new ErrorHttp(400, 'La subida se interrumpió.')));
        destino.on('error', reject);
        destino.on('finish', resolve);
        ctx.req.pipe(destino);
      });
      if (total === 0) throw new ErrorHttp(400, 'El archivo está vacío.');
      const real = await detectarTipo(ruta);
      if (real !== permitido) throw new ErrorHttp(415, 'El contenido del archivo no coincide con su formato (¿está dañado o renombrado?).');
    } catch (e) {
      fs.rm(ruta, { force: true }, () => {});
      throw e;
    }
    let nombre = 'archivo';
    try { nombre = decodeURIComponent(String(ctx.req.headers['x-nombre-archivo'] || 'archivo')).slice(0, 200); } catch { /* nombre por defecto */ }
    db.run('INSERT INTO subidas (id, usuario_id, negocio_id, ruta, nombre_original, tipo, tamano) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, ctx.usuario.id, negocio.id, ruta, nombre, permitido, total);
    enviarJson(ctx.res, 200, { id, tipo: permitido });
  }, { crudo: true });

  // ---------- Paso 2: crear la publicación ----------
  r.post('/negocios/:nid/publicar', async (ctx) => {
    if (!ctx.usuario) return enviarJson(ctx.res, 401, { error: 'Tu sesión terminó. Vuelve a entrar.' });
    const negocio = negocioDeRuta(ctx);
    const u = ctx.usuario;
    try {
      const pagina = paginasPermitidas(u, negocio.id).find((p) => p.id === Number(ctx.form.pagina_id));
      if (!pagina) throw new ErrorHttp(400, 'Elige una de tus páginas.');
      const textoPub = String(ctx.form.texto || '').replace(/\r\n/g, '\n').trim();
      if (textoPub.length > L.textoMax) throw new ErrorHttp(400, `El texto tiene ${textoPub.length} caracteres; el máximo es ${L.textoMax}.`);
      const subida = db.get('SELECT * FROM subidas WHERE id = ? AND usuario_id = ? AND negocio_id = ?',
        texto(ctx.form.subida_id, 64), u.id, negocio.id);
      if (!subida) throw new ErrorHttp(400, 'No se encontró el archivo. Vuelve a seleccionarlo.');

      let media;
      try {
        media = await cloudinary.subir(subida.ruta, {
          tipoRecurso: subida.tipo === 'video' ? 'video' : 'image',
          carpeta: `${config.cloudinary.carpeta}/negocio-${negocio.id}`,
          nombreArchivo: subida.nombre_original,
        });
      } catch (e) {
        throw new ErrorHttp(502, e.message);
      } finally {
        borrarSubida(subida);
      }
      const problema = validarMedidas(subida.tipo, media);
      if (problema) {
        cloudinary.eliminar(media.publicId, subida.tipo === 'video' ? 'video' : 'image');
        throw new ErrorHttp(400, problema);
      }

      const requiere = u.rol === 'proveedor' && u.requiere_aprobacion;
      const estado = requiere ? 'pendiente' : 'en_cola';
      const res = db.run(
        `INSERT INTO publicaciones (negocio_id, pagina_id, usuario_id, tipo, texto, media_url, cloudinary_public_id,
                                    ancho, alto, duracion, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        negocio.id, pagina.id, u.id, subida.tipo, textoPub, media.url, media.publicId,
        media.ancho, media.alto, media.duracion ?? null, estado,
      );
      const id = Number(res.lastInsertRowid);
      registrar(ctx, 'publicacion_creada', {
        negocioId: negocio.id, detalle: { publicacion: id, pagina: pagina.nombre, tipo: subida.tipo, estado },
      });
      if (!requiere) despertarCola();
      seg.flash(ctx, 'exito', requiere
        ? 'Listo. Tu publicación quedó en espera de aprobación.'
        : 'Listo. Tu publicación está en camino; en unos minutos aparecerá en Facebook e Instagram.');
      enviarJson(ctx.res, 200, { ok: true, redirigir: `/negocios/${negocio.id}/publicaciones/${id}` });
    } catch (e) {
      if (!(e instanceof ErrorHttp)) throw e;
      enviarJson(ctx.res, e.status, { error: e.message });
    }
  });

  // ---------- Listado ----------
  r.get('/negocios/:nid/publicaciones', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx);
    enviar(ctx.res, 200, vistaListado(ctx, negocio));
  });

  r.get('/negocios/:nid/publicaciones/:id', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx);
    enviar(ctx.res, 200, vistaDetalle(ctx, negocio, cargarPublicacion(ctx, negocio)));
  });

  // ---------- Acciones ----------
  r.post('/negocios/:nid/publicaciones/:id/aprobar', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const p = cargarPublicacion(ctx, negocio);
    if (p.estado !== 'pendiente') {
      seg.flash(ctx, 'error', 'Esta publicación ya no está pendiente.');
      return redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
    }
    const nuevoTexto = String(ctx.form.texto ?? p.texto).replace(/\r\n/g, '\n').trim();
    if (nuevoTexto.length > L.textoMax) {
      seg.flash(ctx, 'error', `El texto supera los ${L.textoMax} caracteres.`);
      return redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
    }
    const r2 = db.run(
      `UPDATE publicaciones SET estado = 'en_cola', texto = ?, revisado_por = ?, revisado_en = datetime('now')
        WHERE id = ? AND estado = 'pendiente'`,
      nuevoTexto, ctx.usuario.id, p.id,
    );
    if (r2.changes) {
      registrar(ctx, 'publicacion_aprobada', {
        negocioId: negocio.id, detalle: { publicacion: p.id, texto_editado: nuevoTexto !== p.texto },
      });
      despertarCola();
      seg.flash(ctx, 'exito', 'Aprobada. Se está publicando.');
    }
    redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
  });

  r.post('/negocios/:nid/publicaciones/:id/rechazar', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx);
    const p = cargarPublicacion(ctx, negocio);
    const esAutor = p.usuario_id === ctx.usuario.id;
    if (!puedeRevisar(ctx.usuario) && !esAutor) throw prohibido();
    if (p.estado !== 'pendiente') {
      seg.flash(ctx, 'error', 'Esta publicación ya no está pendiente.');
      return redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
    }
    const motivo = puedeRevisar(ctx.usuario) ? texto(ctx.form.motivo, 500) : 'Cancelada por quien la subió.';
    if (!motivo) {
      seg.flash(ctx, 'error', 'Escribe el motivo del rechazo para que el proveedor sepa qué corregir.');
      return redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
    }
    db.run(
      `UPDATE publicaciones SET estado = 'rechazada', motivo_rechazo = ?, revisado_por = ?, revisado_en = datetime('now')
        WHERE id = ? AND estado = 'pendiente'`,
      motivo, ctx.usuario.id, p.id,
    );
    registrar(ctx, 'publicacion_rechazada', { negocioId: negocio.id, detalle: { publicacion: p.id, motivo } });
    seg.flash(ctx, 'exito', esAutor && !puedeRevisar(ctx.usuario) ? 'Publicación cancelada.' : 'Publicación rechazada.');
    redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
  });

  r.post('/negocios/:nid/publicaciones/:id/reintentar', (ctx) => {
    if (!requiereSesion(ctx)) return;
    const negocio = negocioDeRuta(ctx, ['admin', 'dueno']);
    const p = cargarPublicacion(ctx, negocio);
    const r2 = db.run("UPDATE publicaciones SET estado = 'en_cola', detalle_error = NULL WHERE id = ? AND estado = 'error'", p.id);
    if (r2.changes) {
      registrar(ctx, 'publicacion_reintentada', { negocioId: negocio.id, detalle: { publicacion: p.id } });
      despertarCola();
      seg.flash(ctx, 'exito', 'Se volvió a enviar a publicar.');
    }
    redirigir(ctx.res, `/negocios/${negocio.id}/publicaciones/${p.id}`);
  });
}

// ---------- Vistas ----------
function vistaPublicar(ctx, negocio) {
  const u = ctx.usuario;
  const paginas = paginasPermitidas(u, negocio.id);
  const requiere = u.rol === 'proveedor' && u.requiere_aprobacion;
  return pagina(ctx, {
    titulo: 'Publicar', negocio,
    contenido: html`
<div class="encabezado"><h1>Nueva publicación</h1>
  <p class="sutil">Se publica en el muro y en las historias de Facebook e Instagram de la página que elijas.</p></div>
${!paginas.length ? html`<div class="vacio">Todavía no tienes páginas asignadas. Pide al responsable del negocio que te asigne al menos una.</div>` : html`
<noscript><div class="aviso error">Para publicar necesitas tener JavaScript activado en tu navegador.</div></noscript>
${requiere ? html`<div class="aviso info">Tus publicaciones pasan por aprobación antes de salir.</div>` : ''}
<form class="publicar" id="form-publicar" data-subir="/negocios/${negocio.id}/subir" data-publicar="/negocios/${negocio.id}/publicar"
      data-max-imagen="${L.imagenMB}" data-max-video="${L.videoMB}" data-max-texto="${L.textoMax}"
      data-min-seg="${L.videoMinSeg}" data-max-seg="${L.videoMaxSeg}">
  <div class="publicar-campos tarjeta">
    <fieldset>
      <legend>1. Página</legend>
      <div class="opciones-pagina">${paginas.map((p, i) => html`
        <label class="opcion"><input type="radio" name="pagina_id" value="${p.id}" ${paginas.length === 1 || i === 0 ? 'checked' : ''} required><span>${p.nombre}</span></label>`)}
      </div>
    </fieldset>
    <fieldset>
      <legend>2. Archivo</legend>
      <label class="zona-archivo" id="zona-archivo">
        <input type="file" name="archivo" id="archivo" accept="image/jpeg,video/mp4,video/quicktime" required>
        ${icono('publicar')}
        <strong>Toca para elegir una imagen o video</strong>
        <small>Imagen JPG hasta ${L.imagenMB} MB · Video MP4 o MOV vertical 9:16, de ${L.videoMinSeg} a ${L.videoMaxSeg} s, hasta ${L.videoMB} MB</small>
      </label>
      <p class="aviso-archivo" id="aviso-archivo" role="alert" hidden></p>
    </fieldset>
    <fieldset>
      <legend>3. Texto</legend>
      <textarea name="texto" id="texto" rows="6" maxlength="${L.textoMax}" placeholder="Escribe el texto de la publicación o del Reel…"></textarea>
      <div class="contador-texto"><span id="contador">0</span> / ${L.textoMax}</div>
    </fieldset>
    <div class="progreso" id="progreso" hidden>
      <div class="barra-progreso"><div id="barra"></div></div>
      <p id="estado-progreso">Subiendo…</p>
    </div>
    <p class="aviso error" id="error-publicar" role="alert" hidden></p>
    <button type="submit" class="boton primario grande ancho-completo" id="boton-publicar">${requiere ? 'Enviar a aprobación' : 'Publicar'}</button>
  </div>
  <aside class="vista-previa tarjeta">
    <h2>Vista previa</h2>
    <div class="marco-previa" id="previa"><p class="sutil">Aquí verás tu archivo.</p></div>
    <p class="sutil" id="datos-archivo"></p>
  </aside>
</form>`}`,
  });
}

function vistaListado(ctx, negocio) {
  const u = ctx.usuario;
  const filtroEstado = ESTADOS[ctx.query.estado] ? ctx.query.estado : '';
  const filtroPagina = Number(ctx.query.pagina) || 0;
  const pag = Math.max(1, Number(ctx.query.p) || 1);
  const condiciones = ['x.negocio_id = ?'];
  const params = [negocio.id];
  if (u.rol === 'proveedor') { condiciones.push('x.usuario_id = ?'); params.push(u.id); }
  if (filtroEstado) { condiciones.push('x.estado = ?'); params.push(filtroEstado); }
  if (filtroPagina) { condiciones.push('x.pagina_id = ?'); params.push(filtroPagina); }
  const where = condiciones.join(' AND ');
  const total = db.get(`SELECT COUNT(*) AS n FROM publicaciones x WHERE ${where}`, ...params).n;
  const lista = db.all(
    `SELECT x.*, p.nombre AS pagina_nombre, us.nombre AS autor FROM publicaciones x
       JOIN paginas p ON p.id = x.pagina_id LEFT JOIN usuarios us ON us.id = x.usuario_id
      WHERE ${where} ORDER BY CASE x.estado WHEN 'pendiente' THEN 0 ELSE 1 END, x.id DESC LIMIT ? OFFSET ?`,
    ...params, POR_PAGINA, (pag - 1) * POR_PAGINA,
  );
  const paginas = u.rol === 'proveedor' ? paginasPermitidas(u, negocio.id)
    : db.all('SELECT id, nombre FROM paginas WHERE negocio_id = ? ORDER BY nombre', negocio.id);
  const enlace = (cambios) => {
    const q = new URLSearchParams({ estado: filtroEstado, pagina: filtroPagina || '', p: pag, ...cambios });
    for (const [k, v] of [...q]) if (!v || v === '0' || (k === 'p' && v === '1')) q.delete(k);
    const s = q.toString();
    return `/negocios/${negocio.id}/publicaciones${s ? '?' + s : ''}`;
  };
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const hayActivas = lista.some((x) => x.estado === 'en_cola' || x.estado === 'publicando');
  return pagina(ctx, {
    titulo: 'Publicaciones', negocio, ancho: true,
    contenido: html`
<div class="encabezado con-accion">
  <div><h1>${u.rol === 'proveedor' ? 'Mis publicaciones' : 'Publicaciones'}</h1><p class="sutil">${total} en total</p></div>
  <a class="boton primario" href="/negocios/${negocio.id}/publicar">${icono('publicar')} Nueva publicación</a>
</div>
<form method="get" class="filtros" data-auto-enviar>
  <label>Estado<select name="estado">
    <option value="">Todos</option>
    ${Object.entries(ESTADOS).map(([k, e]) => html`<option value="${k}" ${k === filtroEstado ? 'selected' : ''}>${e.texto}</option>`)}
  </select></label>
  ${paginas.length > 1 ? html`<label>Página<select name="pagina">
    <option value="">Todas</option>
    ${paginas.map((p) => html`<option value="${p.id}" ${p.id === filtroPagina ? 'selected' : ''}>${p.nombre}</option>`)}
  </select></label>` : ''}
  <noscript><button class="boton chico">Filtrar</button></noscript>
</form>
${lista.length ? html`
<div class="tarjetas-pub" ${hayActivas ? html`data-auto-recargar="15"` : ''}>
  ${lista.map((x) => html`
  <a class="tarjeta-pub ${x.estado === 'pendiente' ? 'resaltada' : ''}" href="/negocios/${negocio.id}/publicaciones/${x.id}">
    <div class="miniatura">
      <img src="${miniatura(x, 320)}" alt="" loading="lazy">
      ${x.tipo === 'video' ? html`<span class="etiqueta-video">Reel</span>` : ''}
    </div>
    <div class="cuerpo-pub">
      <div class="fila-pub">${insigniaEstado(x.estado)}<small class="sutil">${hace(x.creado)}</small></div>
      <strong>${x.pagina_nombre}</strong>
      <p>${recortar(x.texto, 110) || html`<span class="sutil">Sin texto</span>`}</p>
      ${u.rol !== 'proveedor' ? html`<small class="sutil">Por ${x.autor || 'usuario eliminado'}</small>` : ''}
    </div>
  </a>`)}
</div>
${totalPaginas > 1 ? html`<nav class="paginacion">
  ${pag > 1 ? html`<a class="boton chico" href="${enlace({ p: pag - 1 })}">← Anteriores</a>` : ''}
  <span>Página ${pag} de ${totalPaginas}</span>
  ${pag < totalPaginas ? html`<a class="boton chico" href="${enlace({ p: pag + 1 })}">Siguientes →</a>` : ''}
</nav>` : ''}` : html`<div class="vacio">No hay publicaciones${filtroEstado || filtroPagina ? ' con ese filtro' : ' todavía'}.</div>`}`,
  });
}

function vistaDetalle(ctx, negocio, p) {
  const u = ctx.usuario;
  const revisor = puedeRevisar(u);
  const base = `/negocios/${negocio.id}/publicaciones/${p.id}`;
  const enProceso = p.estado === 'en_cola' || p.estado === 'publicando';
  return pagina(ctx, {
    titulo: `Publicación #${p.id}`, negocio,
    contenido: html`
<div class="encabezado"><a class="volver" href="/negocios/${negocio.id}/publicaciones">← Publicaciones</a>
  <h1>Publicación #${p.id} ${insigniaEstado(p.estado)}</h1></div>
<div class="detalle" ${enProceso ? html`data-auto-recargar="10"` : ''}>
  <section class="tarjeta medio">
    ${p.tipo === 'video'
      ? html`<video src="${p.media_url}" controls playsinline preload="metadata"></video>`
      : html`<img src="${p.media_url}" alt="Imagen de la publicación">`}
    <p class="sutil">${p.tipo === 'video' ? 'Video' : 'Imagen'} · ${p.ancho}×${p.alto}${p.duracion ? ` · ${Number(p.duracion).toFixed(1)} s` : ''}</p>
  </section>
  <section class="tarjeta">
    ${enProceso ? html`<div class="aviso info">${p.estado === 'en_cola' ? 'En cola, empezará en unos segundos.' : 'Publicando en Facebook e Instagram… los videos pueden tardar varios minutos.'} Esta pantalla se actualiza sola.</div>` : ''}
    ${p.estado === 'error' ? html`<div class="aviso error"><strong>No se pudo publicar.</strong><br>${p.detalle_error}</div>` : ''}
    ${p.estado === 'rechazada' ? html`<div class="aviso alerta"><strong>Rechazada${p.revisor ? ` por ${p.revisor}` : ''}.</strong><br>${p.motivo_rechazo}</div>` : ''}
    <dl class="datos">
      <dt>Página</dt><dd>${p.pagina_nombre}</dd>
      <dt>Subida por</dt><dd>${p.autor || 'Usuario eliminado'} · ${fecha(p.creado)}</dd>
      ${p.revisado_en && p.estado !== 'rechazada' ? html`<dt>Aprobada por</dt><dd>${p.revisor || '—'} · ${fecha(p.revisado_en)}</dd>` : ''}
      ${p.publicado_en ? html`<dt>Publicada</dt><dd>${fecha(p.publicado_en)}</dd>` : ''}
      ${p.intentos > 1 ? html`<dt>Intentos</dt><dd>${p.intentos}</dd>` : ''}
    </dl>

    ${p.estado === 'pendiente' && revisor ? html`
    <form method="post" action="${base}/aprobar" class="formulario">
      ${csrfInput(ctx)}
      <label>Texto (puedes corregirlo antes de aprobar)
        <textarea name="texto" rows="7" maxlength="${L.textoMax}">${p.texto}</textarea></label>
      <button type="submit" class="boton primario">Aprobar y publicar</button>
    </form>
    <details class="rechazo">
      <summary>Rechazar</summary>
      <form method="post" action="${base}/rechazar" class="formulario">
        ${csrfInput(ctx)}
        <label>Motivo (lo verá el proveedor)<textarea name="motivo" rows="3" maxlength="500" required></textarea></label>
        <button type="submit" class="boton peligro">Rechazar publicación</button>
      </form>
    </details>` : html`
    <h2>Texto</h2>
    <p class="texto-pub">${p.texto || html`<span class="sutil">Sin texto</span>`}</p>`}

    ${p.estado === 'pendiente' && !revisor && p.usuario_id === u.id ? html`
    <form method="post" action="${base}/rechazar" data-confirmar="¿Cancelar esta publicación?">
      ${csrfInput(ctx)}<button type="submit" class="boton peligro chico">Cancelar publicación</button>
    </form>` : ''}

    ${p.estado === 'error' && revisor ? html`
    <form method="post" action="${base}/reintentar" data-confirmar="Antes de reintentar, revisa en Facebook e Instagram que no se haya publicado parcialmente. ¿Reintentar?">
      ${csrfInput(ctx)}<button type="submit" class="boton primario">Reintentar</button>
    </form>` : ''}
  </section>
</div>`,
  });
}

module.exports = { registrarRutas, limpiarSubidasViejas };
