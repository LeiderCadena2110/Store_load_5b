# Actividad 4 · Perfilar su propio proyecto

Procedimiento exacto para repetir la medición. Es también la primera medición del informe final.

## Carga (Parte A)

- **Aplicación:** Tienda Mínima (`servidor.js`), API Node.js 22 + SQLite con 200.000 productos.
- **Generador:** `carga.js` (propio, sin dependencias), escenario **`mixto`**:
  60% `GET /producto/:id` · 15% `GET /hash` (login, PBKDF2 50.000 iteraciones) · 15% `POST /pedido` (INSERT con fsync) · 10% `GET /catalogo` (1.000 filas).
- **20 usuarios concurrentes**, cada uno hace una petición, espera la respuesta y lanza la siguiente (bucle cerrado, keep-alive).
- **10 s de calentamiento** que no se cuentan + **240 s (4 min) sostenidos** que sí.
- Se registra la latencia de **cada** petición en `datos/actividad4/latencias.csv`.

## Paso a paso (Docker, con `top` e `iostat` reales)

Terminal 1, levantar la API en un contenedor Linux:

```bash
CPUS=2 MEMORIA=1g docker compose up --build -d
```

Terminal 1, lanzar la carga:

```bash
node carga.js --escenario mixto --concurrencia 20 --duracion 240 --calentamiento 10 --salida datos/actividad4/latencias.csv
```

Terminal 2, unos 30 s después, medir dos veces con un minuto de separación:

```bash
docker compose exec api sh medir.sh
```

`medir.sh` ejecuta `top -b -n 2 -d 3 -p PID` (usa la segunda iteración, porque la primera es el promedio desde el arranque), `mpstat -P ALL 3 1` (por núcleo) e `iostat -xy 1 3` (`-y` descarta el informe desde el arranque). Guarda la salida completa en `datos/actividad4/medicion-1.txt` y `medicion-2.txt`.

Al terminar la carga, la terminal 1 imprime pet/s, **p50, p95** y p99.

Para apagar: `docker compose down`.

## Plan B (Windows sin Docker)

```bash
node --no-warnings servidor.js                     # terminal 1
node carga.js --escenario mixto --concurrencia 20 --duracion 240 --calentamiento 10 --salida datos/actividad4/latencias.csv   # terminal 2
powershell -ExecutionPolicy Bypass -File medir-windows.ps1   # terminal 3, a los 30 s
```

Windows no tiene `top`, `iostat` ni la columna `wa`. El script usa los contadores equivalentes (% User Time, % Privileged Time, % Idle Time, Working Set, % Idle Time del disco) y reporta la cola del disco en lugar de `wa`.

## Cómo leer los números

- `us`, `sy`, `id` y `wa` de `top` son el **promedio de todos los núcleos**. Con N núcleos, un solo hilo al 100% se ve como `us ≈ 100/N %`. Por eso también se mira el **%CPU del proceso** (100 = un núcleo lleno) y `mpstat` por núcleo.
- `wa` alto = la CPU está esperando al disco. `%util` cerca de 100 = disco saturado.
- Ley de Little: usuarios ≈ pet/s × latencia promedio. Si se cumple, la latencia es **cola** esperando turno.
