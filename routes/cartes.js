// Routes cartes mémo (protégées). Monté sur /api/cartes.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/cartesController');

router.use(authMiddleware);
router.post('/:id/noter', controller.noter);

module.exports = router;
