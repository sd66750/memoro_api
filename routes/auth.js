// Routes d'authentification (publiques). register / login / refresh / logout.
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const controller = require('../controllers/authController');

// Anti-bruteforce sur les points sensibles.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

router.post('/register', authLimiter, controller.register);
router.post('/login', authLimiter, controller.login);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);

module.exports = router;
