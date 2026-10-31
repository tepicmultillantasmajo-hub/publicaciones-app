'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

let db;

// Cada migración se aplica una sola vez y en orden. Para cambios futuros,
// agrega un elemento nuevo al final; nunca edites uno ya aplicado.
const MIGRACIONES = [
  {
    nombre: '001_inicial',
    sql: `
    CREATE TABLE negocios (
      id INTEGER PRIMARY KEY,
      nombre TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      meta_token_cifrado TEXT,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE paginas (
      id INTEGER PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      fb_page_id TEXT NOT NULL,
      ig_user_id TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_paginas_negocio ON paginas(negocio_id);

    CREATE TABLE usuarios (
      id INTEGER PRIMARY KEY,
      negocio_id INTEGER REFERENCES negocios(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL CHECK (rol IN ('admin','dueno','proveedor')),
      requiere_aprobacion INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      debe_cambiar_password INTEGER NOT NULL DEFAULT 1,
      ultimo_acceso TEXT,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((rol = 'admin') = (negocio_id IS NULL))
    );

    CREATE TABLE asignaciones (
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      pagina_id INTEGER NOT NULL REFERENCES paginas(id) ON DELETE CASCADE,
      PRIMARY KEY (usuario_id, pagina_id)
    );

    CREATE TABLE subidas (
      id TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      ruta TEXT NOT NULL,
      nombre_original TEXT,
      tipo TEXT NOT NULL,
      tamano INTEGER NOT NULL,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE publicaciones (
      id INTEGER PRIMARY KEY,
      negocio_id INTEGER NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
      pagina_id INTEGER NOT NULL REFERENCES paginas(id) ON DELETE CASCADE,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('imagen','video')),
      texto TEXT NOT NULL DEFAULT '',
      media_url TEXT NOT NULL,
      cloudinary_public_id TEXT,
      ancho INTEGER, alto INTEGER, duracion REAL,
      estado TEXT NOT NULL CHECK (estado IN ('pendiente','rechazada','en_cola','publicando','publicada','error')),
      revisado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      revisado_en TEXT,
      motivo_rechazo TEXT,
      detalle_error TEXT,
      resultado TEXT,
      intentos INTEGER NOT NULL DEFAULT 0,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      inicio_publicacion TEXT,
      publicado_en TEXT
    );
    CREATE INDEX idx_pub_negocio ON publicaciones(negocio_id, creado DESC);
    CREATE INDEX idx_pub_estado ON publicaciones(estado);

    CREATE TABLE bitacora (
      id INTEGER PRIMARY KEY,
      negocio_id INTEGER REFERENCES negocios(id) ON DELETE SET NULL,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      accion TEXT NOT NULL,
      detalle TEXT,
      ip TEXT,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_bitacora_negocio ON bitacora(negocio_id, creado DESC);

    CREATE TABLE sesiones (
      id TEXT PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      flash TEXT,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      expira TEXT NOT NULL
    );
    CREATE INDEX idx_sesiones_expira ON sesiones(expira);
    `,
  },
];

function abrir() {
  fs.mkdirSync(config.rutaDatos, { recursive: true });
  fs.mkdirSync(path.join(config.rutaDatos, 'subidas'), { recursive: true });
  db = new DatabaseSync(path.join(config.rutaDatos, 'publicaciones.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS migraciones (nombre TEXT PRIMARY KEY, aplicada TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const m of MIGRACIONES) {
    if (get('SELECT 1 AS x FROM migraciones WHERE nombre = ?', m.nombre)) continue;
    transaccion(() => {
      db.exec(m.sql);
      run('INSERT INTO migraciones (nombre) VALUES (?)', m.nombre);
    });
    console.log(`Migración aplicada: ${m.nombre}`);
  }
  return db;
}

function limpiar(params) {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));
}
function get(sql, ...params) {
  const fila = db.prepare(sql).get(...limpiar(params));
  return fila ? { ...fila } : undefined;
}
function all(sql, ...params) {
  return db.prepare(sql).all(...limpiar(params)).map((f) => ({ ...f }));
}
function run(sql, ...params) {
  return db.prepare(sql).run(...limpiar(params));
}
function transaccion(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrir, get, all, run, transaccion };
