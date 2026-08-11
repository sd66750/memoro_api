// Signature / vérification du JWT d'accès (courte durée). Le refresh est un jeton
// opaque révocable géré côté authController (stocké haché dans mm_refresh_token).
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });
dotenv.config();

const SECRET_KEY = process.env.SECRET_KEY;
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';

/** Émet le JWT d'accès. Charge utile minimale (cloisonnement par id). */
function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, nomAffiche: user.nomAffiche ?? null },
    SECRET_KEY,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

/** Vérifie un JWT d'accès ; lève si invalide/expiré. */
function verifyAccessToken(token) {
  return jwt.verify(token, SECRET_KEY);
}

module.exports = { signAccessToken, verifyAccessToken };
