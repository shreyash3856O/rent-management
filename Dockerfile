# Single-container production image: builds the React frontend, then serves
# it from the Express backend on :4000. Slim (glibc) base because the Turso
# client ships native bindings. Needs Node 22+.
FROM node:22-slim AS febuild
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-slim
# ca-certificates is required: without it the Turso TLS sync fails on boot
# with "no valid native root CA certificates found".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=febuild /app/frontend/dist /app/frontend/dist
ENV NODE_ENV=production PORT=4000 DB_PATH=/data/prm.sqlite
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/app.js"]
