// Maîtrise : moyenne des pourcentages des tentatives QCM non archivées, pondérée
// en faveur des passages récents (poids 0.85^i, i=0 = plus récent). Par cours,
// puis agrégée par matière (brief §6).
const db = require('../config/db').promise();

function ponderee(pcts /* récents en premier */) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < pcts.length; i++) {
    const w = Math.pow(0.85, i);
    num += w * Number(pcts[i]);
    den += w;
  }
  return den ? Math.round((num / den) * 100) / 100 : null;
}

/** Map idCours -> maîtrise (ou absente si aucune tentative). */
async function maitriseParCours(idUtilisateur) {
  const [rows] = await db.query(
    `SELECT idCours, pourcentage
       FROM mm_qcm_tentative
      WHERE idUtilisateur = ? AND surSupportArchive = 0 AND pourcentage IS NOT NULL
      ORDER BY idCours, finLe DESC`,
    [idUtilisateur]
  );
  const byCours = new Map();
  for (const r of rows) {
    if (!byCours.has(r.idCours)) byCours.set(r.idCours, []);
    byCours.get(r.idCours).push(r.pourcentage);
  }
  const out = new Map();
  for (const [k, v] of byCours) out.set(k, ponderee(v));
  return out;
}

module.exports = { ponderee, maitriseParCours };
