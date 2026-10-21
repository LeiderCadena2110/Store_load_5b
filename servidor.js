// Tienda Mínima: API de 4 endpoints + SQLite, sin dependencias externas.
// Cada endpoint está diseñado para "esperar" en un componente distinto:
//   GET  /producto/:id   -> lectura por índice (memoria / caché de páginas)
//   GET  /hash           -> cálculo PBKDF2 (CPU, un solo hilo)
//   POST /pedido         -> INSERT con fsync en cada commit (disco, IOPS)
//   GET  /catalogo       -> respuesta JSON grande (red / bytes de salida)
// Ejecutar:  node servidor.js     (variables: PUERTO, DB, METRICAS_DIR)

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const metricas = require('./metricas');

const PUERTO = Number(process.env.PUERTO) || 3000;
const DB = process.env.DB || path.join(__dirname, 'datos', 'tienda.db');
const N_PRODUCTOS = 200_000;          // tamaño de la tabla de productos
const ITERACIONES_HASH = 50_000;      // trabajo de CPU por petición en /hash

fs.mkdirSync(path.dirname(DB), { recursive: true });
const db = new DatabaseSync(DB);
// synchronous=FULL + journal DELETE: cada INSERT obliga al SO a escribir en disco (fsync).
db.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY, nombre TEXT, categoria TEXT, precio REAL, descripcion TEXT);
  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, producto_id INTEGER, cantidad INTEGER, creado TEXT);
`);

// Siembra automática la primera vez (datos de prueba deterministas).
const total = db.prepare('SELECT COUNT(*) AS n FROM productos').get().n;
if (total < N_PRODUCTOS) {
  console.log(`Sembrando ${N_PRODUCTOS} productos (solo la primera vez)...`);
  const cats = ['frutas', 'verduras', 'lacteos', 'granos', 'carnes', 'hierbas'];
  const ins = db.prepare('INSERT OR REPLACE INTO productos VALUES (?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 1; i <= N_PRODUCTOS; i++) {
    ins.run(i, `Producto ${i}`, cats[i % cats.length], ((i * 7919) % 50000) + 500,
      `Descripcion del producto ${i} cultivado en Narino, categoria ${cats[i % cats.length]}`);
  }
  db.exec('COMMIT');
}

const porId = db.prepare('SELECT * FROM productos WHERE id = ?');
const pagina = db.prepare('SELECT * FROM productos WHERE id > ? ORDER BY id LIMIT 1000');
const insertar = db.prepare('INSERT INTO pedidos (producto_id, cantidad, creado) VALUES (?,?,?)');

function responder(res, codigo, obj) {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(codigo, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}

function leerCuerpo(req) {
  return new Promise((ok) => {
    let datos = '';
    req.on('data', (c) => (datos += c));
    req.on('end', () => { try { ok(JSON.parse(datos || '{}')); } catch { ok({}); } });
  });
}

const servidor = http.createServer(async (req, res) => {
  metricas.contar('peticiones');
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/salud') {
      return responder(res, 200, { ok: true, pid: process.pid });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/producto/')) {
      const fila = porId.get(Number(url.pathname.split('/')[2]));
      return fila ? responder(res, 200, fila) : responder(res, 404, { error: 'no existe' });
    }
    if (req.method === 'GET' && url.pathname === '/hash') {
      const clave = url.searchParams.get('clave') || 'secreto';
      const h = crypto.pbkdf2Sync(clave, 'sal-fija', ITERACIONES_HASH, 32, 'sha256');
      return responder(res, 200, { hash: h.toString('hex') });
    }
    if (req.method === 'POST' && url.pathname === '/pedido') {
      const b = await leerCuerpo(req);
      const r = insertar.run(Number(b.producto_id) || 1, Number(b.cantidad) || 1, new Date().toISOString());
      metricas.contar('escrituras_bd');
      return responder(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if (req.method === 'GET' && url.pathname === '/catalogo') {
      const desde = Number(url.searchParams.get('desde')) || 0;
      return responder(res, 200, pagina.all(desde));
    }
    responder(res, 404, { error: 'ruta no encontrada' });
  } catch (e) {
    responder(res, 500, { error: e.message });
  }
});

servidor.keepAliveTimeout = 65_000;
metricas.iniciar(servidor);
servidor.listen(PUERTO, () => console.log(`Tienda Mínima escuchando en http://localhost:${PUERTO}  (pid ${process.pid})`));

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { metricas.detener(); process.exit(0); });
