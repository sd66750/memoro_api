// Routes tableau de bord / progression / paramètres / révision libre (protégées).
// Monté sur /api.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const progression = require('../controllers/progressionController');
const revisions = require('../controllers/revisionsController');

router.use(authMiddleware);
router.get('/aujourdhui', revisions.getAujourdhui);
router.get('/progression', progression.getProgression);
router.put('/parametres', progression.updateParametres);
router.post('/revision-libre', progression.revisionLibre);
router.post('/revision-libre/qcm', progression.soumettreLibre);

module.exports = router;
