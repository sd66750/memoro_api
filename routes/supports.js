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
const MAX_PDF_MO = 100;
const upload = multer({ storage, limits: { fileSize: MAX_PDF_MO * 1024 * 1024 } });

// Enveloppe multer pour renvoyer une erreur claire (413) si le PDF est trop gros,
// au lieu d'une erreur générique remontée par le gestionnaire global.
function uploadPdf(req, res, next) {
  upload.single('fichier')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `PDF trop volumineux (maximum ${MAX_PDF_MO} Mo).` });
      }
      return res.status(400).json({ error: err.message || "Échec de l'envoi du fichier." });
    }
    next();
  });
}

router.post('/cours/:idCours/support', authMiddleware, uploadPdf, controller.upload);
router.post('/cours/:idCours/regenerer', authMiddleware, controller.regenerer);
router.get('/cours/:idCours/supports', authMiddleware, controller.list);
router.get('/supports/:id/fichier', authMiddleware, controller.serve);

module.exports = router;
