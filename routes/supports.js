// Routes des supports (PDF). Monté sur /api.
// Dépôt via « handoff nginx » : le corps du PDF est écrit sur le disque partagé par
// nginx (app-memoro) dans STORAGE_DIR/_up, et api-memoro le récupère via l'en-tête
// X-Body-File — le gros transfert passe par nginx (rapide) et ne touche jamais le
// socket de node (plafonné à ~8 Ko/s à travers le bridge docker de ce VPS).
const path = require('path');
const fs = require('fs');
const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/supportsController');

const router = express.Router();

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
// Dossier tampon où nginx (autre conteneur, uid non-root) dépose le corps de l'upload.
// 0777 pour que le worker nginx puisse y écrire ; api-memoro (root) y déplace ensuite.
const UP_DIR = path.join(STORAGE_DIR, '_up');
try {
  fs.mkdirSync(UP_DIR, { recursive: true });
  fs.chmodSync(UP_DIR, 0o777);
} catch (e) {
  console.warn('Création du dossier tampon uploads impossible:', e.message);
}

router.post('/cours/:idCours/support', authMiddleware, controller.upload);
router.post('/cours/:idCours/regenerer', authMiddleware, controller.regenerer);
router.get('/cours/:idCours/supports', authMiddleware, controller.list);
router.get('/supports/:id/fichier', authMiddleware, controller.serve);

module.exports = router;
