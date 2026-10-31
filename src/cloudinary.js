'use strict';
// Subida firmada a Cloudinary. El secreto nunca sale del servidor.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');

function firmar(params) {
  const cadena = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(cadena + config.cloudinary.apiSecret).digest('hex');
}

async function subir(rutaArchivo, { tipoRecurso, carpeta, nombreArchivo }) {
  const c = config.cloudinary;
  const params = { folder: carpeta, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  const blob = await fs.openAsBlob(rutaArchivo);
  form.append('file', blob, nombreArchivo || path.basename(rutaArchivo));
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('api_key', c.apiKey);
  form.append('signature', firmar(params));

  const resp = await fetch(`${c.apiUrl}/v1_1/${encodeURIComponent(c.cloud)}/${tipoRecurso}/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10 * 60e3),
  });
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok || !datos.secure_url) {
    const msg = datos.error && datos.error.message ? datos.error.message : `HTTP ${resp.status}`;
    throw new Error(`Cloudinary rechazó el archivo: ${msg}`);
  }
  return {
    url: datos.secure_url,
    publicId: datos.public_id,
    ancho: datos.width,
    alto: datos.height,
    duracion: datos.duration,
    formato: datos.format,
  };
}

async function eliminar(publicId, tipoRecurso) {
  if (!publicId) return;
  const c = config.cloudinary;
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
  const form = new URLSearchParams({ ...params, api_key: c.apiKey, signature: firmar(params) });
  try {
    await fetch(`${c.apiUrl}/v1_1/${encodeURIComponent(c.cloud)}/${tipoRecurso}/destroy`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(30e3),
    });
  } catch (e) {
    console.warn('No se pudo borrar de Cloudinary:', publicId, e.message);
  }
}

module.exports = { subir, eliminar };
