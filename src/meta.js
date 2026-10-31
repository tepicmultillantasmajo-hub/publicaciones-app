'use strict';
// Verifica que el token del negocio tenga acceso a una página y su Instagram.
const { config } = require('./config');

async function verificarPagina(token, pageId, igId) {
  const url = `${config.meta.graphUrl}/${encodeURIComponent(pageId)}?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`;
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(20e3) });
  } catch (e) {
    return { ok: false, mensaje: `No se pudo contactar a Meta: ${e.message}` };
  }
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok || datos.error) {
    return { ok: false, mensaje: `Meta respondió: ${(datos.error && datos.error.message) || 'HTTP ' + resp.status}` };
  }
  const ig = datos.instagram_business_account;
  if (!ig) {
    return { ok: false, mensaje: `Página "${datos.name}" accesible, pero no tiene una cuenta de Instagram profesional vinculada.` };
  }
  if (String(ig.id) !== String(igId)) {
    return {
      ok: false,
      mensaje: `Página "${datos.name}" accesible, pero su Instagram vinculado es @${ig.username} (ID ${ig.id}), no el ID guardado ${igId}.`,
    };
  }
  return { ok: true, mensaje: `Conexión correcta: "${datos.name}" e Instagram @${ig.username}.` };
}

module.exports = { verificarPagina };
