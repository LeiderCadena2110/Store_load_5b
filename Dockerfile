FROM node:22-alpine
WORKDIR /app
COPY servidor.js metricas.js ./
ENV DB=/bd/tienda.db METRICAS_DIR=/app/datos/metricas PUERTO=3000
EXPOSE 3000
CMD ["node", "--no-warnings", "servidor.js"]
