# memoro_api

API de **Memoro** (révision par répétition espacée). Express.js (CommonJS),
MySQL, JWT access + refresh, génération de contenus via `@anthropic-ai/sdk`.

Conventions calquées sur HomeFlowAPI. Voir `../CLAUDE.md`.

## Démarrer

```bash
npm install
cp .env.local.example .env.local   # puis renseigner les valeurs
npm start                          # nodemon server.js (port 8090 par défaut)
```

## Base de données

Migrations dans `migrations/` (SQL, `CREATE TABLE IF NOT EXISTS`, préfixe `mm_`).
Appliquer `migrations/001_schema_initial.sql` sur la base `memoro`.

## Organisation

- `server.js` — entrée, monte `/api/<domaine>`
- `routes/` + `controllers/` par domaine, agrégés par `routes/index.js`
- `middlewares/authMiddleware.js` — JWT Bearer → `req.user`
- `config/db.js` — pool `mysql2`
- `utils/jwt.js` — JWT d'accès

Ne rien déployer sans validation explicite.
