# Single-container production image: builds the React frontend, then serves
# it from the Express backend on :4000. Needs Node 22+ (uses node:sqlite).
FROM node:22-alpine AS febuild
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=febuild /app/frontend/dist /app/frontend/dist
ENV NODE_ENV=production PORT=4000 DB_PATH=/data/prm.sqlite UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "src/app.js"]
