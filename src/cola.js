'use strict';
// Cola de publicación: toma publicaciones "en_cola" y se las entrega al
// workflow motor de n8n por la red interna de Docker. n8n responde cuando
// termina (Respond to Webhook al final), o con error si algo falla.
const { config } = require('./config');
const db = require('./db');
const { descifrar } = require('./seguridad');
const { registrar } = require('./auditoria');

let enCurso = 0;
let iniciado = false;

function recuperarInterrumpidas() {
  const r = db.run(
    `UPDATE publicaciones SET estado = 'error', detalle_error = ?
      WHERE estado = 'publicando'`,
    'La app se reinició mientras se publicaba. Revisa en Facebook e Instagram si salió antes de reintentar.',
  );
  if (r.changes) console.warn(`${r.changes} publicación(es) interrumpidas marcadas como error.`);
}

function tomarSiguiente() {
  return db.transaccion(() => {
    const p = db.get("SELECT * FROM publicaciones WHERE estado = 'en_cola' ORDER BY id LIMIT 1");
    if (!p) return null;
    db.run(
      `UPDATE publicaciones SET estado = 'publicando', intentos = intentos + 1,
              inicio_publicacion = datetime('now'), detalle_error = NULL WHERE id = ?`,
      p.id,
    );
    return p;
  });
}

async function procesar(p) {
  const pagina = db.get('SELECT * FROM paginas WHERE id = ?', p.pagina_id);
  const negocio = db.get('SELECT * FROM negocios WHERE id = ?', p.negocio_id);
  try {
    if (!negocio || !negocio.activo) throw new Error('El negocio está desactivado.');
    if (!pagina || !pagina.activo) throw new Error('La página está desactivada.');
    if (!negocio.meta_token_cifrado) throw new Error('El negocio no tiene configurado el token de Meta.');

    const resp = await fetch(config.n8n.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Publicador-Secret': config.n8n.secreto },
      body: JSON.stringify({
        publicacion_id: p.id,
        negocio: negocio.nombre,
        pagina: pagina.nombre,
        page_id: pagina.fb_page_id,
        ig_id: pagina.ig_user_id,
        url: p.media_url,
        tipo: p.tipo === 'imagen' ? 'image' : 'video',
        texto: p.texto,
        token: descifrar(negocio.meta_token_cifrado),
      }),
      signal: AbortSignal.timeout(config.n8n.timeoutMin * 60e3),
    });
    const cuerpo = await resp.text();
    if (!resp.ok) throw new Error(`n8n respondió ${resp.status}: ${cuerpo.slice(0, 500) || 'sin detalle'}`);

    db.run(
      `UPDATE publicaciones SET estado = 'publicada', publicado_en = datetime('now'), resultado = ?
        WHERE id = ?`,
      cuerpo.slice(0, 4000), p.id,
    );
    registrar(null, 'publicacion_publicada', {
      negocioId: p.negocio_id, usuarioId: null, detalle: { publicacion: p.id, pagina: pagina.nombre },
    });
  } catch (e) {
    let msg = e.message;
    if (e.name === 'TimeoutError') {
      msg = `n8n no respondió en ${config.n8n.timeoutMin} minutos. Revisa la ejecución en n8n y en las páginas antes de reintentar.`;
    } else if (e.cause && e.cause.code === 'ECONNREFUSED') {
      msg = 'No se pudo conectar con n8n (¿está encendido y en la misma red?).';
    } else if (e.cause && e.cause.code === 'ENOTFOUND') {
      msg = 'No se encontró el servidor de n8n. Revisa N8N_WEBHOOK_URL y la red de Docker.';
    }
    db.run("UPDATE publicaciones SET estado = 'error', detalle_error = ? WHERE id = ?", msg, p.id);
    registrar(null, 'publicacion_error', {
      negocioId: p.negocio_id, usuarioId: null, detalle: { publicacion: p.id, error: msg.slice(0, 300) },
    });
    console.error(`Publicación ${p.id} con error:`, msg);
  }
}

function revisarCola() {
  while (enCurso < config.n8n.simultaneas) {
    const p = tomarSiguiente();
    if (!p) break;
    enCurso++;
    procesar(p).finally(() => {
      enCurso--;
      setImmediate(revisarCola);
    });
  }
}

function iniciarCola() {
  if (iniciado) return;
  iniciado = true;
  recuperarInterrumpidas();
  setInterval(revisarCola, 5000);
  revisarCola();
}

module.exports = { iniciarCola, despertarCola: () => setImmediate(revisarCola) };
