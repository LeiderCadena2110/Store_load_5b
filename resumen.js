// Cruza las latencias (del generador) con los recursos (del servidor) por ventana de tiempo
// y produce la tabla que va al informe.
// Uso:  node resumen.js <etiqueta>      -> datos/<etiqueta>/resumen.md y resumen.csv
const fs = require('node:fs');
const path = require('node:path');

const DATOS = path.join(__dirname, 'datos');

function leerMetricas() {
  const dir = path.join(DATOS, 'metricas');
  if (!fs.existsSync(dir)) return [];
  const filas = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.csv'))) {
    const [cab, ...lineas] = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
    const cols = cab.split(',');
    for (const l of lineas) {
      const v = l.split(',');
      const o = {};
      cols.forEach((c, i) => (o[c] = v[i] === '' || v[i] === undefined ? null : Number(v[i])));
      filas.push(o);
    }
  }
  return filas;
}

const prom = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const f = (x, d = 1) => (x === null || Number.isNaN(x) ? '—' : x.toFixed(d));

function pista(m) {
  if (m.cpu_prom >= 85) return 'CPU: el hilo principal está saturado';
  if (m.cgroup_estr && m.cgroup_estr > 50) return 'CPU: el límite del contenedor estrangula';
  if (m.disco_escr_prom !== null && m.disco_escr_prom > 50 && m.cpu_prom < 60) return 'Disco: espera de fsync/IOPS';
  if (m.red_salida_prom > 20_000) return 'Red: muchos bytes por segundo';
  if (m.cpu_prom < 40) return 'Sin saturación clara (sobra capacidad)';
  return 'Mixto: revisar columnas';
}

function resumir(etiqueta) {
  const dir = path.join(DATOS, etiqueta);
  const manifiesto = JSON.parse(fs.readFileSync(path.join(dir, 'manifiesto.json'), 'utf8'));
  const metricas = leerMetricas();
  const filas = [];

  for (const r of manifiesto) {
    const ventana = metricas.filter((m) => m.ts_ms >= r.inicio_ms + 1000 && m.ts_ms <= r.fin_ms);
    const col = (c) => ventana.map((m) => m[c]).filter((x) => x !== null && x !== undefined);
    const nucleos = Object.keys(ventana[0] || {}).filter((c) => /^nucleo\d+_pct$/.test(c));
    // Núcleo más ocupado: promedio de cada núcleo y nos quedamos con el mayor.
    const nucleoMasOcupado = max(nucleos.map((c) => prom(col(c))));
    const m = {
      escenario: r.escenario, usuarios: r.concurrencia,
      pet_s: r.peticiones_por_s, p50: r.p50_ms, p95: r.p95_ms, p99: r.p99_ms, error_pct: r.error_pct,
      cpu_prom: prom(col('cpu_proceso_pct')), cpu_pico: max(col('cpu_proceso_pct')),
      nucleo_max_prom: nucleoMasOcupado,
      rss_prom: prom(col('rss_mb')), rss_pico: max(col('rss_mb')),
      bucle_uso: prom(col('bucle_eventos_uso_pct')),
      disco_escr_prom: prom(col('disco_iops_escr')), disco_mbs_escr: prom(col('disco_mb_s_escr')),
      disco_lect_prom: prom(col('disco_iops_lect')),
      escrituras_bd: prom(col('escrituras_bd_s')),
      red_entrada_prom: prom(col('red_entrada_kb_s')), red_salida_prom: prom(col('red_salida_kb_s')),
      cgroup_mem: max(col('cgroup_mem_mb')), cgroup_estr: prom(col('cgroup_estrangulado_ms_s')),
      muestras: ventana.length,
    };
    m.pista = ventana.length ? pista(m) : 'Sin métricas del servidor en esta ventana';
    filas.push(m);
  }

  // CSV completo (dato crudo agregado)
  const claves = Object.keys(filas[0]);
  fs.writeFileSync(path.join(dir, 'resumen.csv'),
    [claves.join(','), ...filas.map((x) => claves.map((k) => (typeof x[k] === 'number' ? +x[k].toFixed(3) : `"${x[k] ?? ''}"`)).join(','))].join('\n'));

  // Tablas Markdown para pegar en el informe
  const t1 = ['| Endpoint | Usuarios | Pet/s | p50 ms | p95 ms | p99 ms | Error % |', '|---|---|---|---|---|---|---|',
    ...filas.map((x) => `| ${x.escenario} | ${x.usuarios} | ${f(x.pet_s)} | ${f(x.p50, 2)} | ${f(x.p95, 2)} | ${f(x.p99, 2)} | ${f(x.error_pct, 2)} |`)];
  const t2 = ['| Endpoint | Usuarios | CPU proceso prom/pico % | Núcleo más ocupado % | RSS prom/pico MB | Uso bucle % | IOPS escr. | MB/s escr. | Red entra/sale KB/s | Cont. mem MB | Estrangul. ms/s | Pista |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...filas.map((x) => `| ${x.escenario} | ${x.usuarios} | ${f(x.cpu_prom)} / ${f(x.cpu_pico)} | ${f(x.nucleo_max_prom)} | ${f(x.rss_prom)} / ${f(x.rss_pico)} | ${f(x.bucle_uso)} | ${f(x.disco_escr_prom)} | ${f(x.disco_mbs_escr, 2)} | ${f(x.red_entrada_prom)} / ${f(x.red_salida_prom)} | ${f(x.cgroup_mem)} | ${f(x.cgroup_estr)} | ${x.pista} |`)];
  const md = `# Resumen: ${etiqueta}\n\n## Latencia y rendimiento\n\n${t1.join('\n')}\n\n## Recursos durante la carga\n\n${t2.join('\n')}\n\n` +
    '> "CPU proceso" es % de UN núcleo (100% = un núcleo lleno). "Pista" es automática: confírmenla con los números antes de afirmarla.\n';
  fs.writeFileSync(path.join(dir, 'resumen.md'), md);
  console.log(`\n${md}\nGuardado en ${path.join(dir, 'resumen.md')} y resumen.csv`);
}

module.exports = { resumir };
if (require.main === module) {
  if (!process.argv[2]) { console.error('Uso: node resumen.js <etiqueta>'); process.exit(1); }
  resumir(process.argv[2]);
}
