FROM node:22-bookworm-slim
# procps = top, pgrep · sysstat = iostat, mpstat  (herramientas de la Actividad 4)
RUN apt-get update && apt-get install -y --no-install-recommends procps sysstat \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY servidor.js metricas.js medir.sh ./
ENV DB=/bd/tienda.db METRICAS_DIR=/app/datos/metricas PUERTO=3000
EXPOSE 3000
CMD ["node", "--no-warnings", "servidor.js"]
