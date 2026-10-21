// Generador de carga sostenida, sin dependencias.
// Mantiene N "usuarios" concurrentes durante D segundos y guarda la latencia de CADA petición.
// Uso:  node carga.js --escenario hash --concurrencia 10 --duracion 300 [--calentamiento 15]
//                     [--base http://localhost:3000] [--salida datos/prueba.csv]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const azar = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const ESCENARIOS = {
  producto: () => ({ metodo: 'GET', ruta: `/producto/${azar(1, 200000)}` }),
  hash:     () => ({ metodo: 'GET', ruta: `/hash?clave=usuario${azar(1, 1e6)}` }),
  pedido:   () => ({ metodo: 'POST', ruta: '/pedido',
                     cuerpo: JSON.stringify({ producto_id: azar(1, 200000), cantidad: azar(1, 5) }) }),
  catalogo: () => ({ metodo: 'GET', ruta: `/catalogo?desde=${azar(0, 199000)}` }),
};

function percentil(ordenado, p) {
  if (!ordenado.length) return 0;
  return ordenado[Math.min(ordenado.length - 1, Math.ceil((p / 100) * ordenado.length) - 1)];
}

async function correr({ escenario, concurrencia, duracion, calentamiento = 15, base = 'http://localhost:3000', salida }) {
  const gen = ESCENARIOS[escenario];
  if (!gen) throw new Error(`Escenario desconocido: ${escenario}. Use: ${Object.keys(ESCENARIOS).join(', ')}`);
  const url = new URL(base);
  const agente = new http.Agent({ keepAlive: true, maxSockets: concurrencia });

  const peticion = () => new Promise((ok) => {
    const { metodo, ruta, cuerpo } = gen();
    const t0 = performance.now();
    const req = http.request({
      host: url.hostname, port: url.port, path: ruta, method: metodo, agent: agente,
      headers: cuerpo ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) } : {},
    }, (res) => {
      res.resume();
      res.on('end', () => ok({ ms: performance.now() - t0, estado: res.statusCode }));
    });
    req.on('error', () => ok({ ms: performance.now() - t0, estado: 0 }));
    if (cuerpo) req.write(cuerpo);
    req.end();
  });

  let flujo;
  if (salida) {
    fs.mkdirSync(path.dirname(salida), { recursive: true });
    flujo = fs.createWriteStream(salida);
    flujo.write('ts_ms,latencia_ms,estado\n');
  }

  const latencias = [];
  let errores = 0;
  const inicioCal = Date.now();
  const inicio = inicioCal + calentamiento * 1000;   // el calentamiento no se registra
  const fin = inicio + duracion * 1000;

  const usuario = async () => {
    while (Date.now() < fin) {
      const ts = Date.now();
      const r = await peticion();
      if (ts < inicio) continue;
      latencias.push(r.ms);
      if (r.estado < 200 || r.estado >= 400) errores++;
      if (flujo) flujo.write(`${ts},${r.ms.toFixed(3)},${r.estado}\n`);
    }
  };
  await Promise.all(Array.from({ length: concurrencia }, usuario));
  agente.destroy();
  if (flujo) await new Promise((ok) => flujo.end(ok));

  latencias.sort((a, b) => a - b);
  return {
    escenario, concurrencia, duracion_s: duracion,
    inicio_ms: inicio, fin_ms: fin,
    peticiones: latencias.length,
    peticiones_por_s: +(latencias.length / duracion).toFixed(1),
    errores, error_pct: +((100 * errores) / Math.max(1, latencias.length)).toFixed(2),
    p50_ms: +percentil(latencias, 50).toFixed(2),
    p95_ms: +percentil(latencias, 95).toFixed(2),
    p99_ms: +percentil(latencias, 99).toFixed(2),
    max_ms: +(latencias[latencias.length - 1] || 0).toFixed(2),
    promedio_ms: +(latencias.reduce((a, b) => a + b, 0) / Math.max(1, latencias.length)).toFixed(2),
  };
}

module.exports = { correr, ESCENARIOS };

if (require.main === module) {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  correr({
    escenario: a.escenario || 'producto',
    concurrencia: Number(a.concurrencia) || 10,
    duracion: Number(a.duracion) || 60,
    calentamiento: a.calentamiento !== undefined ? Number(a.calentamiento) : 15,
    base: a.base || 'http://localhost:3000',
    salida: a.salida,
  }).then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
