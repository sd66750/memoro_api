# Image de production de l'API Memoro (Express, CommonJS).
# Toutes les dépendances Node sont pures JS (bcryptjs, mysql2, multer, @anthropic-ai/sdk)
# → aucune compilation native. Ghostscript est ajouté pour compresser les PDF déposés
# (ré-échantillonnage /ebook 150 dpi) : stockage réduit + repasse sous la limite IA.
# Écoute sur le port 3000 (attendu par traefik : loadbalancer.server.port=3000).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apk add --no-cache ghostscript

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# Stockage des PDF déposés — monté en volume en prod pour survivre aux rebuilds
# (voir DEPLOY.md : ./storage:/app/storage).
RUN mkdir -p /app/storage

EXPOSE 3000
CMD ["node", "server.js"]
