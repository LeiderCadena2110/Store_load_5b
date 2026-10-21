# Tienda Mínima — proyecto "Dimensionar una carga real"

API pequeña hecha desde cero para el Momento Evaluativo 3: **4 endpoints + base de datos SQLite**, sin dependencias externas (solo Node.js). Trae todo para medir: generador de carga, muestreador de recursos y un script que arma la tabla del informe.

Cada endpoint está diseñado para **esperar en un componente distinto**, porque eso es lo que se califica:

| Endpoint | Qué hace | Componente que debería limitarlo |
|---|---|---|
| `GET /producto/:id` | lee 1 fila por clave primaria (índice B-tree) | memoria / caché de páginas del SO |
| `GET /hash` | PBKDF2-SHA256 con 50.000 iteraciones | **CPU**, y un solo hilo (parte secuencial) |
| `POST /pedido` | INSERT con `synchronous=FULL` (fsync en cada commit) | **disco** (IOPS y latencia de escritura) |
| `GET /catalogo` | devuelve 1.000 productos en JSON (~150 KB) | **red** / serialización en CPU |

La base de datos tiene 200.000 productos y se crea sola la primera vez que arranca.

---

## Requisitos

- **Node.js 22.13 o superior** (trae SQLite incluido: `node --version`).
- **Docker Desktop** solo para la opción "contenedor con límites".

No hay `npm install`: no hay paquetes que instalar.

---

## Paso 1 — Verificar las dos condiciones (antes del 21 de octubre)

```bash
node --no-warnings servidor.js
```

En otra terminal:

```bash
curl http://localhost:3000/producto/42          # condición 1: arranca sin servicios externos
node carga.js --escenario hash --concurrencia 10 --duracion 20   # condición 2: se le puede generar carga
```

Si las dos funcionan, las condiciones están verificadas.

---

## Paso 2 — Medir en la máquina física (semanas del 21 y 28 de octubre)

Con el servidor corriendo (`node --no-warnings servidor.js`):

```bash
node experimento.js fisica 300
```

Eso corre los 4 endpoints con 1, 10 y 50 usuarios, **5 minutos sostenidos cada uno** (15 s de calentamiento que no se cuentan, y 10 s de pausa entre pruebas). Dura unos **65 minutos**. No usen el computador mientras corre.

Al final imprime la tabla y deja en `datos/fisica/`:

- `latencias-<endpoint>-c<usuarios>.csv` → **cada petición** con su latencia (dato crudo).
- `manifiesto.json` → inicio, fin, pet/s, p50, p95, p99 de cada prueba.
- `maquina.json` → ficha técnica del equipo (CPU, núcleos, RAM, SO).
- `resumen.md` / `resumen.csv` → la tabla para el informe.

Y en `datos/metricas/` queda un CSV con **una fila por segundo** de recursos del servidor: CPU del proceso, CPU **por núcleo**, memoria residente (RSS), uso del bucle de eventos, red entrada/salida, IOPS y MB/s de disco, y (en contenedor) memoria del cgroup y tiempo estrangulado.

> Para una prueba rápida de todo el flujo: `node experimento.js prueba 20`

### Si están en Windows

CPU, memoria y red se miden igual. El disco (IOPS, MB/s) se lee de Linux, así que en Windows esas columnas salen vacías. Hay dos salidas: correr la API en Docker (paso 3), que es Linux, o tomar el disco con `medir-windows.ps1` mientras corre el experimento (ver `ACTIVIDAD4.md`).

> `typeperf` con nombres de contador en inglés falla si Windows está en español; por eso el script usa clases CIM.

---

## Paso 3 — Contenedor con límites

Detengan el servidor de Node (Ctrl+C) y levanten el contenedor con los límites que ustedes definan:

```bash
CPUS=1 MEMORIA=256m docker compose up --build -d
node experimento.js contenedor-1cpu 300
docker compose down
```

Repitan con otro límite para tener comparación:

```bash
CPUS=2 MEMORIA=512m docker compose up --build -d
node experimento.js contenedor-2cpu 300
docker compose down
```

En Windows PowerShell las variables se ponen así: `$env:CPUS=1; $env:MEMORIA="256m"; docker compose up --build -d`

Opcional, como segunda fuente: `docker stats --format "{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}}"` en otra terminal.

Columnas que solo aparecen en el contenedor y que valen oro en la sustentación:

- **Cont. mem MB**: memoria que el contenedor realmente usa frente al límite.
- **Estrangul. ms/s**: milisegundos por segundo que el kernel **frenó** al proceso por pasarse del límite de CPU.

---

## Paso 4 — Instancia de nube (semana del 4 de noviembre)

No hace falta pagarla. Elijan una instancia concreta (AWS, Azure, Google Cloud o DigitalOcean), copien su **ficha técnica** (vCPU, RAM, tipo de disco y su IOPS base, ancho de banda) y su **precio mensual** desde la página oficial o la calculadora del proveedor, con la fecha de consulta.

Compárenla contra **sus** mediciones. Por ejemplo:

- Si `/hash` llena un núcleo al 100%, ¿cuántas vCPU tiene la instancia y cuántas usaría Node con un solo proceso?
- Si `/pedido` necesitó N IOPS de escritura, ¿el disco de la instancia da esa cantidad de IOPS base?
- Si el RSS máximo fue X MB, ¿cuánta RAM sobra?

---

## Cómo leer los resultados (lo que se pregunta en la sustentación)

- **"CPU proceso" es % de UN núcleo.** 100% = un núcleo lleno. Node ejecuta su JavaScript en **un solo hilo**: si `/hash` llega a ~100% y las pet/s **no suben** al pasar de 1 a 10 usuarios, es la parte secuencial (Amdahl). Más núcleos no ayudan sin varios procesos.
- **"Núcleo más ocupado" puede ser menor que "CPU proceso"**: el SO mueve el hilo entre núcleos, así que la carga se reparte en el promedio por núcleo aunque en cada instante solo uno trabaje.
- **"Uso bucle %" alto con CPU baja** = el hilo está **bloqueado esperando** algo (en `/pedido`, el fsync del disco).
- **Latencia que crece ~10× con 10× usuarios sin que suban las pet/s** = cola: las peticiones esperan turno.
- **La columna "Pista" es automática.** Úsenla como punto de partida y confírmenla con los números antes de afirmarla.

## Limitación que deben mencionar en el informe

El generador de carga corre en la **misma máquina** que la API, así que también consume CPU. Díganlo, y si pueden, repitan una prueba con el generador en otro computador de la misma red: `BASE=http://IP-DEL-SERVIDOR:3000 node experimento.js fisica-remoto 300`.

---

## Archivos

| Archivo | Para qué |
|---|---|
| `servidor.js` | la API (4 endpoints + SQLite) |
| `metricas.js` | muestrea recursos cada segundo y los guarda en CSV |
| `carga.js` | generador de carga sostenida (registra la latencia de cada petición) |
| `experimento.js` | corre todos los escenarios de forma repetible |
| `resumen.js` | cruza latencias y recursos y arma las tablas del informe |
| `Dockerfile`, `docker-compose.yml` | opción contenedor con límites |
