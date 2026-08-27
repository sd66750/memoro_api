// Routes QCM (protégées). Monté sur /api/qcm.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const controller = require('../controllers/qcmController');

router.use(authMiddleware);
router.get('/:id/take', controller.take);
router.post('/:id/tentative', controller.soumettre);

module.exports = router;
