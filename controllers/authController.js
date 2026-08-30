// Authentification : inscription, connexion, rotation du refresh, déconnexion.
// Access = JWT court ; refresh = jeton opaque révocable (haché en base).
const crypto = require('crypto');
// bcryptjs (pur JS) : hash bcrypt compatible, aucune compilation native au build.
const bcrypt = require('bcryptjs');
const db = require('../config/db').promise();
const { signAccessToken } = require('../utils/jwt');

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const PALIERS_DEFAUT = '[1,3,7,14,30]';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/** Crée un refresh token opaque, le stocke haché, renvoie la valeur en clair. */
async function issueRefreshToken(idUtilisateur) {
  const raw = crypto.randomBytes(48).toString('hex');
  const expire = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
  await db.query(
    `INSERT INTO mm_refresh_token (idUtilisateur, tokenHash, expireLe) VALUES (?,?,?)`,
    [idUtilisateur, sha256(raw), expire]
  );
  return raw;
}

function sessionPayload(user, accessToken, refreshToken) {
  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, nomAffiche: user.nomAffiche ?? null },
  };
}

exports.register = async (req, res, next) => {
  try {
    // Inscriptions FERMÉES par défaut (comptes créés manuellement). Pour rouvrir :
    // définir MEMORO_INSCRIPTIONS=open dans l'environnement de l'API.
    if (process.env.MEMORO_INSCRIPTIONS !== 'open') {
      return res.status(403).json({ error: 'Les inscriptions sont fermées pour le moment.' });
    }
    const { email, motDePasse, nomAffiche } = req.body || {};
    if (!email || !motDePasse) {
      return res.status(400).json({ error: 'Email et mot de passe obligatoires.' });
    }
    const [exist] = await db.query('SELECT id FROM mm_utilisateur WHERE email = ?', [email]);
    if (exist.length) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }
    const hash = await bcrypt.hash(motDePasse, 10);
    const [ins] = await db.query(
      `INSERT INTO mm_utilisateur (email, motDePasseHash, nomAffiche) VALUES (?,?,?)`,
      [email, hash, nomAffiche || null]
    );
    const id = ins.insertId;
    // Ligne de paramètres par défaut (paliers J).
    await db.query(
      `INSERT INTO mm_parametre (idUtilisateur, paliersJson) VALUES (?,?)`,
      [id, PALIERS_DEFAUT]
    );
    const user = { id, email, nomAffiche: nomAffiche || null };
    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(id);
    res.status(201).json(sessionPayload(user, accessToken, refreshToken));
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, motDePasse } = req.body || {};
    if (!email || !motDePasse) {
      return res.status(400).json({ error: 'Email et mot de passe obligatoires.' });
    }
    const [rows] = await db.query(
      'SELECT id, email, motDePasseHash, nomAffiche, actif FROM mm_utilisateur WHERE email = ?',
      [email]
    );
    const user = rows[0];
    if (!user || !user.actif) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    const ok = await bcrypt.compare(motDePasse, user.motDePasseHash);
    if (!ok) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);
    res.json(sessionPayload(user, accessToken, refreshToken));
  } catch (err) {
    next(err);
  }
};

exports.refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token manquant.' });
    const hash = sha256(refreshToken);
    const [rows] = await db.query(
      `SELECT t.id, t.idUtilisateur, u.email, u.nomAffiche
         FROM mm_refresh_token t
         JOIN mm_utilisateur u ON u.id = t.idUtilisateur
        WHERE t.tokenHash = ? AND t.estRevoque = 0 AND t.expireLe > NOW()`,
      [hash]
    );
    const row = rows[0];
    if (!row) return res.status(403).json({ error: 'Refresh token invalide ou expiré.' });
    // Rotation : on révoque l'ancien et on en émet un nouveau.
    await db.query('UPDATE mm_refresh_token SET estRevoque = 1 WHERE id = ?', [row.id]);
    const user = { id: row.idUtilisateur, email: row.email, nomAffiche: row.nomAffiche };
    const accessToken = signAccessToken(user);
    const newRefresh = await issueRefreshToken(user.id);
    res.json(sessionPayload(user, accessToken, newRefresh));
  } catch (err) {
    next(err);
  }
};

exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      await db.query('UPDATE mm_refresh_token SET estRevoque = 1 WHERE tokenHash = ?', [sha256(refreshToken)]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};
