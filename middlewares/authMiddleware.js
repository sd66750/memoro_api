// Vérifie le JWT Bearer et pose req.user (cloisonnement par req.user.id).
// Calqué sur HomeFlowAPI/middlewares/authMiddleware.js (sans les routes publiques
// spécifiques à HomeFlow — Memoro déclare ses routes publiques dans le routeur).
const { verifyAccessToken } = require('../utils/jwt');

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Fallback : token en query (EventSource/SSE ne supporte pas les headers).
  const queryToken = req.query.token;

  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Accès non autorisé' });
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token invalide ou expiré' });
  }
};
