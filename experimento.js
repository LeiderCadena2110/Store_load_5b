// Corre TODOS los escenarios de carga de forma repetible y guarda los datos crudos.
// Uso:  node experimento.js <etiqueta> [duracion_s]
//   etiqueta: nombre de la opción medida, p. ej. "fisica", "contenedor-1cpu", "contenedor-2cpu"
//   duracion_s: segundos de carga sostenida por escenario (por defecto 300 = 5 minutos)
// Variables opcionales: BASE (url de la API), NIVELES ("1,10,50"), ESCENARIOS ("producto,hash,pedido,catalogo")
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { correr } = require('./carga');
const { resumir } = require('./resumen');

const etiqueta = process.argv[2];
if (!etiqueta) { console.error('Uso: node experimento.js <etiqueta> [duracion_s]'); process.exit(1); }
const duracion = Number(process.argv[3]) || 300;
const BASE = process.env.BASE || 'http://localhost:3000';
const NIVELES = (process.env.NIVELES || '1,10,50').split(',').map(Number);
const ESCENARIOS = (process.env.ESCENARIOS || 'producto,hash,pedido,catalogo').split(',');
const dir = path.join(__dirname, 'datos', etiqueta);
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  try {
    const r = await fetch(`${BASE}/salud`);
    if (!r.ok) throw new Error();
  } catch {
    console.error(`La API no responde en ${BASE}. Arránquenla primero (node servidor.js o docker compose up).`);
    process.exit(1);
  }

  fs.mkdirSync(dir, { recursive: true });
  // Ficha técnica de la máquina donde corre la carga (para el informe).
  fs.writeFileSync(path.join(dir, 'maquina.json'), JSON.stringify({
    etiqueta, fecha: new Date().toISOString(), base: BASE,
    so: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus()[0]?.model, nucleos_logicos: os.cpus().length,
    ram_total_gb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version,
  }, null, 2));

  const total = ESCENARIOS.length * NIVELES.length;
  const minutos = Math.ceil((total * (duracion + 25)) / 60);
  console.log(`Experimento "${etiqueta}": ${total} pruebas de ${duracion}s cada una (~${minutos} min en total).`);

  const resultados = [];
  let k = 0;
  for (const escenario of ESCENARIOS) {
    for (const concurrencia of NIVELES) {
      k++;
      process.stdout.write(`[${k}/${total}] ${escenario} con ${concurrencia} usuarios... `);
      const r = await correr({
        escenario, concurrencia, duracion, calentamiento: 15, base: BASE,
        salida: path.join(dir, `latencias-${escenario}-c${concurrencia}.csv`),
      });
      resultados.push(r);
      console.log(`${r.peticiones_por_s} pet/s, p50 ${r.p50_ms} ms, p95 ${r.p95_ms} ms, p99 ${r.p99_ms} ms, errores ${r.error_pct}%`);
      fs.writeFileSync(path.join(dir, 'manifiesto.json'), JSON.stringify(resultados, null, 2));
      await pausa(10_000); // la máquina descansa entre pruebas
    }
  }
  resumir(etiqueta);
})();
