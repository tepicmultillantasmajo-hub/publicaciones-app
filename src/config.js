'use strict';
// Toda la configuración llega por variables de entorno (ver .env.example).

function num(nombre, defecto) {
  const v = Number(process.env[nombre]);
  return Number.isFinite(v) && v > 0 ? v : defecto;
}

const config = {
  puerto: num('PORT', 3000),
  nombreApp: process.env.APP_NAME || 'Centro de Publicaciones',
  urlPublica: (process.env.APP_URL || '').replace(/\/+$/, ''),
  zonaHoraria: process.env.APP_TIMEZONE || 'America/Mazatlan',
  rutaDatos: process.env.DATA_DIR || '/data',
  cookieSegura: process.env.COOKIE_SECURE !== 'false',
  sesionHoras: num('SESION_HORAS', 12),
  claveCifrado: process.env.APP_ENCRYPTION_KEY || '',

  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  cloudinary: {
    cloud: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    apiUrl: process.env.CLOUDINARY_API_URL || 'https://api.cloudinary.com',
    carpeta: process.env.CLOUDINARY_FOLDER || 'publicaciones',
  },

  n8n: {
    url: process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/motor-publicacion',
    secreto: process.env.N8N_WEBHOOK_SECRET || '',
    timeoutMin: num('N8N_TIMEOUT_MIN', 15),
    simultaneas: num('MAX_PUBLICACIONES_SIMULTANEAS', 2),
  },

  meta: {
    graphUrl: process.env.META_GRAPH_URL || 'https://graph.facebook.com/v25.0',
  },

  limites: {
    imagenMB: num('MAX_IMAGEN_MB', 8),
    videoMB: num('MAX_VIDEO_MB', 100),
    videoMinSeg: num('VIDEO_MIN_SEG', 3),
    videoMaxSeg: num('VIDEO_MAX_SEG', 60),
    textoMax: 2200,
  },
};

function validarConfig() {
  const faltan = [];
  if (config.claveCifrado.length < 32) faltan.push('APP_ENCRYPTION_KEY (mínimo 32 caracteres)');
  if (!config.n8n.secreto || config.n8n.secreto.length < 16) faltan.push('N8N_WEBHOOK_SECRET (mínimo 16 caracteres)');
  if (!config.cloudinary.cloud || !config.cloudinary.apiKey || !config.cloudinary.apiSecret) {
    faltan.push('CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET');
  }
  if (faltan.length) {
    console.error('Faltan variables de entorno obligatorias:\n  - ' + faltan.join('\n  - '));
    process.exit(1);
  }
}

module.exports = { config, validarConfig };
