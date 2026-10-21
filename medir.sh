#!/bin/sh
# Actividad 4 · Toma las 7 mediciones con top e iostat, DOS veces separadas por un minuto.
# Correr MIENTRAS la carga está andando (empezar unos 30 s después de lanzarla).
#   Dentro del contenedor:  docker compose exec api sh medir.sh
#   En Linux / WSL:         sh medir.sh
# Guarda la salida completa de cada comando en datos/actividad4/ (es la evidencia).

DIR=datos/actividad4
mkdir -p "$DIR"
PID=$(pgrep -f "^node .*servidor.js" | head -1)
if [ -z "$PID" ]; then echo "No encuentro el proceso servidor.js. ¿Está corriendo la API?"; exit 1; fi

tomar() {
  N=$1
  F="$DIR/medicion-$N.txt"
  echo "===== Medición $N · $(date '+%Y-%m-%d %H:%M:%S') · PID $PID =====" > "$F"

  # top: la PRIMERA iteración es el promedio desde el arranque; usamos la segunda (últimos 3 s).
  top -b -n 2 -d 3 -p "$PID" | awk 'BEGIN{n=0} /^top -/{n++} n==2' > "$DIR/.top"
  echo; echo "--- top -b -n 2 -d 3 -p $PID   (segunda iteración) ---" >> "$F"
  cat "$DIR/.top" >> "$F"

  # Por núcleo: muestra si un solo núcleo está al tope.
  echo; echo "--- mpstat -P ALL 3 1   (por núcleo) ---" >> "$F"
  mpstat -P ALL 3 1 >> "$F"

  # iostat -x: -y descarta el primer informe (que también es desde el arranque).
  iostat -xy 1 3 > "$DIR/.iostat"
  echo; echo "--- iostat -xy 1 3 ---" >> "$F"
  cat "$DIR/.iostat" >> "$F"

  # Extraer los 7 valores (los dos que faltan, p50/p95, salen del generador de carga).
  CPU=$(grep -m1 '%Cpu' "$DIR/.top" | tr ',' '.')
  US=$(echo "$CPU" | sed -E 's/.* ([0-9.]+) us.*/\1/')
  SY=$(echo "$CPU" | sed -E 's/.* ([0-9.]+) sy.*/\1/')
  ID=$(echo "$CPU" | sed -E 's/.* ([0-9.]+) id.*/\1/')
  WA=$(echo "$CPU" | sed -E 's/.* ([0-9.]+) wa.*/\1/')
  RES=$(awk -v p="$PID" '$1==p {print $6}' "$DIR/.top")
  PROC=$(awk -v p="$PID" '$1==p {print $9}' "$DIR/.top")
  # %util es la última columna; nos quedamos con el disco más ocupado del último informe.
  UTIL=$(awk '/^Device/{blk++; next} blk==3 && NF>2 {u=$NF+0; if(u>m){m=u; d=$1}} END{printf "%.1f%% (%s)", m, d}' "$DIR/.iostat")

  {
    echo; echo "===== RESUMEN medición $N ====="
    echo "CPU usuario (us):      $US %"
    echo "CPU sistema (sy):      $SY %"
    echo "Espera E/S (wa):       $WA %"
    echo "Ocioso (id):           $ID %"
    echo "RES del proceso:       $RES  (KiB salvo que diga m/g)   · %CPU del proceso: $PROC"
    echo "Disco %util:           $UTIL"
  } | tee -a "$F"
  rm -f "$DIR/.top" "$DIR/.iostat"
  echo "Salida completa guardada en $F"
}

tomar 1
echo; echo "Esperando 60 s para la segunda medición (no detengan la carga)..."; sleep 60
tomar 2
echo; echo "Listo. Ahora saquen captura de pantalla de estos resúmenes y de la tabla del generador."
