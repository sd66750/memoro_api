// Paliers J : à la création d'un cours qui possède un support, on programme une
// mm_revision par palier, calculée depuis dateCours (brief §6). Idempotent : ne
// fait rien si des révisions existent déjà pour ce cours.
const db = require('../config/db').promise();

function addDaysISO(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

async function lirePaliers(idUtilisateur) {
  const [prm] = await db.query('SELECT paliersJson FROM mm_parametre WHERE idUtilisateur = ?', [idUtilisateur]);
  let paliers = [1, 3, 7, 14, 30];
  const raw = prm[0]?.paliersJson;
  if (raw) {
    try {
      const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(p) && p.length) paliers = p.map(Number).filter((n) => Number.isFinite(n));
    } catch {
      /* défaut conservé */
    }
  }
  return paliers;
}

/** Programme les révisions d'un cours. Renvoie le nombre créé (0 si déjà fait). */
async function genererRevisions(idUtilisateur, idCours, dateCours) {
  const [existing] = await db.query('SELECT COUNT(*) AS n FROM mm_revision WHERE idCours = ?', [idCours]);
  if (existing[0].n > 0) return 0;
  const paliers = await lirePaliers(idUtilisateur);
  const values = paliers.map((j, i) => [idUtilisateur, idCours, i, addDaysISO(dateCours, j)]);
  if (!values.length) return 0;
  await db.query('INSERT INTO mm_revision (idUtilisateur, idCours, indexPalier, dueLe) VALUES ?', [values]);
  return values.length;
}

module.exports = { genererRevisions, lirePaliers, addDaysISO };
