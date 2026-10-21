// Muestreador de recursos: escribe una fila por segundo en datos/metricas/servidor-<inicio>.csv
// Funciona en cualquier SO; en Linux (y dentro de Docker) agrega disco real y límites del contenedor.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const DIR = process.env.METRICAS_DIR || path.join(__dirname, 'datos', 'metricas');
const contadores = { peticiones: 0, escrituras_bd: 0 };
const sockets = new Set();
let bytesCerradosIn = 0, bytesCerradosOut = 0;
let temporizador, archivo;

const leer = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// Suma de operaciones de disco de los dispositivos físicos (Linux).
function disco() {
  const t = leer('/proc/diskstats');
  if (!t) return null;
  let lecturas = 0, escrituras = 0, sectLeidos = 0, sectEscritos = 0;
  for (const l of t.trim().split('\n')) {
    const c = l.trim().split(/\s+/);
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(c[2])) continue;
    lecturas += +c[3]; sectLeidos += +c[5]; escrituras += +c[7]; sectEscritos += +c[9];
  }
  return { lecturas, escrituras, bytesLeidos: sectLeidos * 512, bytesEscritos: sectEscritos * 512 };
}

// Bytes que el propio proceso pidió leer/escribir al disco (Linux).
function ioProceso() {
  const t = leer('/proc/self/io');
  if (!t) return null;
  const o = {};
  for (const l of t.trim().split('\n')) { const [k, v] = l.split(':'); o[k.trim()] = +v; }
  return o;
}

// Límites del contenedor (cgroup v2): memoria usada y estrangulamiento de CPU.
function cgroup() {
  const mem = leer('/sys/fs/cgroup/memory.current');
  const stat = leer('/sys/fs/cgroup/cpu.stat');
  if (!mem && !stat) return null;
  const o = { memoria: mem ? +mem : null, throttled_usec: null, nr_throttled: null };
  if (stat) for (const l of stat.trim().split('\n')) {
    const [k, v] = l.split(' ');
    if (k === 'throttled_usec' || k === 'nr_throttled') o[k] = +v;
  }
  return o;
}

function red() {
  let i = bytesCerradosIn, o = bytesCerradosOut;
  for (const s of sockets) { i += s.bytesRead; o += s.bytesWritten; }
  return { i, o };
}

function iniciar(servidor) {
  servidor.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => { bytesCerradosIn += s.bytesRead; bytesCerradosOut += s.bytesWritten; sockets.delete(s); });
  });

  fs.mkdirSync(DIR, { recursive: true });
  archivo = path.join(DIR, `servidor-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const nucleos = os.cpus().length;
  const cab = ['ts_ms', 'peticiones_s', 'cpu_proceso_pct',
    ...Array.from({ length: nucleos }, (_, k) => `nucleo${k}_pct`),
    'rss_mb', 'heap_mb', 'bucle_eventos_uso_pct', 'bucle_retraso_p99_ms',
    'red_entrada_kb_s', 'red_salida_kb_s', 'escrituras_bd_s',
    'disco_iops_lect', 'disco_iops_escr', 'disco_mb_s_lect', 'disco_mb_s_escr',
    'proc_mb_s_escr', 'proc_syscalls_escr_s',
    'cgroup_mem_mb', 'cgroup_estrangulado_ms_s'];
  fs.writeFileSync(archivo, cab.join(',') + '\n');

  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let prev = {
    t: performance.now(), cpu: process.cpuUsage(), nuc: os.cpus().map((c) => c.times),
    elu: performance.eventLoopUtilization(), red: red(), disco: disco(), io: ioProceso(), cg: cgroup(),
    cont: { ...contadores },
  };

  temporizador = setInterval(() => {
    const ahora = {
      t: performance.now(), cpu: process.cpuUsage(), nuc: os.cpus().map((c) => c.times),
      elu: performance.eventLoopUtilization(), red: red(), disco: disco(), io: ioProceso(), cg: cgroup(),
      cont: { ...contadores },
    };
    const seg = (ahora.t - prev.t) / 1000;
    const d = (a, b) => (a - b) / seg;
    const cpuUs = ahora.cpu.user + ahora.cpu.system - prev.cpu.user - prev.cpu.system;
    const nucPct = ahora.nuc.map((x, k) => {
      const p = prev.nuc[k]; const tot = (o) => o.user + o.nice + o.sys + o.idle + o.irq;
      const dt = tot(x) - tot(p); return dt > 0 ? (100 * (1 - (x.idle - p.idle) / dt)).toFixed(1) : '';
    });
    const elu = performance.eventLoopUtilization(ahora.elu, prev.elu);
    const mem = process.memoryUsage();
    const fila = [
      Date.now(), d(ahora.cont.peticiones, prev.cont.peticiones).toFixed(1),
      (cpuUs / 10_000 / seg).toFixed(1), ...nucPct,
      (mem.rss / 1048576).toFixed(1), (mem.heapUsed / 1048576).toFixed(1),
      (elu.utilization * 100).toFixed(1), (lag.percentile(99) / 1e6).toFixed(1),
      (d(ahora.red.i, prev.red.i) / 1024).toFixed(1), (d(ahora.red.o, prev.red.o) / 1024).toFixed(1),
      d(ahora.cont.escrituras_bd, prev.cont.escrituras_bd).toFixed(1),
      ahora.disco ? d(ahora.disco.lecturas, prev.disco.lecturas).toFixed(1) : '',
      ahora.disco ? d(ahora.disco.escrituras, prev.disco.escrituras).toFixed(1) : '',
      ahora.disco ? (d(ahora.disco.bytesLeidos, prev.disco.bytesLeidos) / 1048576).toFixed(3) : '',
      ahora.disco ? (d(ahora.disco.bytesEscritos, prev.disco.bytesEscritos) / 1048576).toFixed(3) : '',
      ahora.io ? (d(ahora.io.write_bytes, prev.io.write_bytes) / 1048576).toFixed(3) : '',
      ahora.io ? d(ahora.io.syscw, prev.io.syscw).toFixed(1) : '',
      ahora.cg && ahora.cg.memoria != null ? (ahora.cg.memoria / 1048576).toFixed(1) : '',
      ahora.cg && ahora.cg.throttled_usec != null
        ? (d(ahora.cg.throttled_usec, prev.cg.throttled_usec) / 1000).toFixed(1) : '',
    ];
    fs.appendFileSync(archivo, fila.join(',') + '\n');
    lag.reset();
    prev = ahora;
  }, 1000);
  temporizador.unref();
  console.log(`Métricas -> ${archivo}`);
}

module.exports = {
  iniciar,
  contar: (k) => { contadores[k]++; },
  detener: () => clearInterval(temporizador),
};
