// Routes des cours (protégées : cloisonnées par utilisateur) + contenus dérivés
// (en-tête, fiche, cartes, QCM) et validation d'un palier depuis la page du cours.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/coursController');
const contenus = require('../controllers/coursContenusController');
const revisions = require('../controllers/revisionsController');
const cartes = require('../controllers/cartesController');

router.use(authMiddleware);

router.get('/', controller.getAll);
// Route spécifique avant /:id pour ne pas être capturée par le paramètre.
router.post('/duplicate-semaine', controller.duplicateWeek);

// Contenus dérivés (chemins à deux segments : pas de conflit avec /:id).
router.get('/:id/entete', contenus.getEntete);
router.get('/:id/synthese', contenus.getSynthese);
router.get('/:id/cartes/export', cartes.exportCsv);
router.get('/:id/cartes', contenus.getCartes);
router.get('/:id/qcm/tentatives', contenus.getQcmHistorique);
router.get('/:id/qcm/liste', contenus.getQcmListe);
router.post('/:id/qcm/generer', contenus.genererNouveauQcm);
router.get('/:id/qcm', contenus.getQcm);
router.post('/:id/valider', revisions.valider);

router.get('/:id', controller.getById);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.delete('/:id', controller.remove);

module.exports = router;
