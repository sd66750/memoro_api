// Routes des supports (PDF). Monté sur /api. Dépôt en multipart (champ 'fichier'),
// stockage disque hors web-root (STORAGE_DIR). Service authentifié (le token peut
// passer en query pour l'affichage inline dans un <embed>).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/supportsController');

const router = express.Router();

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 40 * 1024 * 1024 } });

router.post('/cours/:idCours/support', authMiddleware, upload.single('fichier'), controller.upload);
router.post('/cours/:idCours/regenerer', authMiddleware, controller.regenerer);
router.get('/cours/:idCours/supports', authMiddleware, controller.list);
router.get('/supports/:id/fichier', authMiddleware, controller.serve);

module.exports = router;
