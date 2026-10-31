'use strict';

class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}
const noEncontrado = (m = 'No encontrado') => new ErrorHttp(404, m);
const prohibido = (m = 'No tienes permiso para ver esto') => new ErrorHttp(403, m);

class Router {
  constructor() {
    this.rutas = [];
  }
  agregar(metodo, patron, fn, opciones = {}) {
    const claves = [];
    const re = new RegExp(
      '^' + patron.replace(/:(\w+)/g, (_, k) => {
        claves.push(k);
        return '([^/]+)';
      }) + '/?$',
    );
    this.rutas.push({ metodo, re, claves, fn, opciones });
  }
  get(p, fn, o) { this.agregar('GET', p, fn, o); }
  post(p, fn, o) { this.agregar('POST', p, fn, o); }
  buscar(metodo, ruta) {
    for (const r of this.rutas) {
      if (r.metodo !== metodo) continue;
      const m = r.re.exec(ruta);
      if (m) {
        const params = {};
        r.claves.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { fn: r.fn, params, opciones: r.opciones };
      }
    }
    return null;
  }
}

function leerCookies(cabecera = '') {
  const o = {};
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    try { o[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim()); } catch { /* ignorar */ }
  }
  return o;
}

function leerCuerpo(req, limiteBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limiteBytes) {
        reject(new ErrorHttp(413, 'Los datos enviados son demasiado grandes.'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function leerFormulario(req) {
  const tipo = req.headers['content-type'] || '';
  if (!tipo.startsWith('application/x-www-form-urlencoded')) return {};
  const cuerpo = await leerCuerpo(req, 1024 * 1024);
  const o = {};
  for (const [k, v] of new URLSearchParams(cuerpo.toString('utf8'))) {
    if (k in o) o[k] = [].concat(o[k], v);
    else o[k] = v;
  }
  return o;
}

// IP real del cliente: Traefik agrega la IP de quien se conecta al final de X-Forwarded-For.
function ipCliente(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const partes = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (partes.length) return partes[partes.length - 1];
  }
  return req.socket.remoteAddress || '';
}

function enviar(res, status, cuerpo, tipo = 'text/html; charset=utf-8') {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', tipo);
  res.end(cuerpo);
}
function enviarJson(res, status, obj) {
  enviar(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}
function redirigir(res, url) {
  if (res.headersSent) return;
  res.statusCode = 303;
  res.setHeader('Location', url);
  res.end();
}

module.exports = {
  ErrorHttp, noEncontrado, prohibido, Router,
  leerCookies, leerCuerpo, leerFormulario, ipCliente,
  enviar, enviarJson, redirigir,
};
