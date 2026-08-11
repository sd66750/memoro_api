// Point d'entrée de l'API Memoro. Organisation calquée sur HomeFlowAPI/server.js.
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });
dotenv.config();

const db = require('./config/db');
const routes = require('./routes');

const app = express();

// CORS : liste d'origines autorisées (front dev + domaines de prod).
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(morgan('dev'));
app.set('trust proxy', true);

// Vérifie la connexion au pool au démarrage.
db.getConnection((err, connection) => {
  if (err) {
    console.error('Erreur de connexion au pool MySQL:', err.message);
    return;
  }
  console.log('Connexion MySQL réussie');
  connection.release();
});

// Sonde de santé (utile pour le déploiement / le healthcheck Docker).
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'memoro_api' }));

// Routes métier.
app.use('/api/auth', routes.auth);
app.use('/api/matieres', routes.matieres);
// Supports monté sur /api (chemins /cours/:id/support & /supports/:id/fichier) —
// avant le routeur cours pour capter le dépôt multipart.
app.use('/api', routes.supports);
app.use('/api/cours', routes.cours);
app.use('/api/qcm', routes.qcm);
app.use('/api/cartes', routes.cartes);
// Tableau de bord / progression / paramètres / révision libre (chemins dédiés).
app.use('/api', routes.progression);

// 404 JSON.
app.use((req, res) => res.status(404).json({ error: 'Ressource introuvable.' }));

// Gestionnaire d'erreurs centralisé.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log(`Memoro API démarrée sur le port ${PORT}`));
