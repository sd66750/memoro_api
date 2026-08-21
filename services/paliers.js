// Paliers J : à la création d'un cours qui possède un support, on programme une
// mm_revision par palier depuis dateCours (brief §6). Depuis la « charge
// absorbable », le placement est désormais SOUS BUDGET : chaque révision porte
// une durée estimée (temps 0 du cours) et se pose sur le jour le moins chargé de
// sa fenêtre de dérive (rattrapage vers l'avant), sans dépasser le budget/jour.
// La cible J (dueLeIdeal) reste la courbe d'oubli ; on ne fait que la lisser.
const db = require('../config/db').promise();
const { today } = require('../utils/dates');
const { dureeRevision, deriveMax, BUDGET_DEFAUT } = require('./charge');

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

/** Budget d'absorption (minutes/jour) de l'utilisateur. */
async function lireBudget(idUtilisateur) {
  const [prm] = await db.query('SELECT budgetQuotidienMin FROM mm_parametre WHERE idUtilisateur = ?', [idUtilisateur]);
  const b = Number(prm[0]?.budgetQuotidienMin);
  return Number.isFinite(b) && b > 0 ? b : BUDGET_DEFAUT;
}

/** Charge (minutes) par jour des révisions non faites dans [fromIso, toIso]. */
async function chargeParJour(idUtilisateur, fromIso, toIso) {
  const [rows] = await db.query(
    "SELECT dueLe, SUM(dureeEstimeeMin) AS min FROM mm_revision WHERE idUtilisateur = ? AND statut IN ('due','reportee') AND dueLe BETWEEN ? AND ? GROUP BY dueLe",
    [idUtilisateur, fromIso, toIso]
  );
  const map = new Map();
  for (const r of rows) map.set(String(r.dueLe).slice(0, 10), Number(r.min) || 0);
  return map;
}

/**
 * Pose une révision au plus tôt à partir de sa cible, sans dépasser le budget,
 * dans la fenêtre de dérive. Si aucun jour ne convient, on la pose à
 * ideal+driftMax (jour en surbudget assumé et visible) avec surcharge=true.
 */
function placer(idealIso, duree, budget, chargeMap, driftMax) {
  for (let d = 0; d <= driftMax; d++) {
    const jour = addDaysISO(idealIso, d);
    const actuel = chargeMap.get(jour) || 0;
    if (actuel + duree <= budget) return { dueLe: jour, surcharge: false };
  }
  return { dueLe: addDaysISO(idealIso, driftMax), surcharge: true };
}

/** Programme les révisions d'un cours sous budget. Renvoie le nombre créé (0 si déjà fait). */
async function genererRevisions(idUtilisateur, idCours, dateCours) {
  const [existing] = await db.query('SELECT COUNT(*) AS n FROM mm_revision WHERE idCours = ?', [idCours]);
  if (existing[0].n > 0) return 0;
  const paliers = await lirePaliers(idUtilisateur);
  if (!paliers.length) return 0;
  const [cr] = await db.query('SELECT niveauCharge FROM mm_cours WHERE id = ?', [idCours]);
  const niveau = cr[0]?.niveauCharge || 'moyen';
  const budget = await lireBudget(idUtilisateur);
  const dateISO = String(dateCours).slice(0, 10);
  const horizon = addDaysISO(dateISO, Math.max(...paliers) + 30);
  const charge = await chargeParJour(idUtilisateur, dateISO, horizon);

  const values = [];
  paliers.forEach((j, i) => {
    const ideal = addDaysISO(dateISO, j);
    const duree = dureeRevision(niveau, i);
    const { dueLe } = placer(ideal, duree, budget, charge, deriveMax(i));
    charge.set(dueLe, (charge.get(dueLe) || 0) + duree); // réserve la place (évite d'empiler les paliers du même cours)
    values.push([idUtilisateur, idCours, i, dueLe, ideal, duree]);
  });
  await db.query(
    'INSERT INTO mm_revision (idUtilisateur, idCours, indexPalier, dueLe, dueLeIdeal, dureeEstimeeMin) VALUES ?',
    [values]
  );
  return values.length;
}

/** Met à jour la durée estimée des révisions non faites d'un cours (changement de niveau). */
async function majDureesCours(idUtilisateur, idCours, niveau) {
  const [revs] = await db.query(
    "SELECT id, indexPalier FROM mm_revision WHERE idUtilisateur = ? AND idCours = ? AND statut IN ('due','reportee')",
    [idUtilisateur, idCours]
  );
  for (const r of revs) {
    await db.query('UPDATE mm_revision SET dureeEstimeeMin = ? WHERE id = ?', [dureeRevision(niveau, r.indexPalier), r.id]);
  }
  return revs.length;
}

/**
 * Recalcule le placement du FUTUR (révisions non faites, dueLe >= aujourd'hui).
 * Passé et révisions faites restent figés. Ordre de priorité : retard (reportée)
 * d'abord, puis coefficient de matière ↓, palier bas, ancienneté du cours.
 */
async function recalculerPlanning(idUtilisateur) {
  const budget = await lireBudget(idUtilisateur);
  const [revs] = await db.query(
    `SELECT r.id, r.idCours, r.indexPalier, r.dueLe, r.dueLeIdeal, r.dureeEstimeeMin, r.statut,
            c.niveauCharge, c.dateCours, COALESCE(m.coefficient, 1) AS coef
       FROM mm_revision r
       JOIN mm_cours c ON c.id = r.idCours
       LEFT JOIN mm_matiere m ON m.id = c.idMatiere
      WHERE r.idUtilisateur = ? AND r.statut IN ('due','reportee') AND r.dueLe >= CURDATE()`,
    [idUtilisateur]
  );
  if (!revs.length) return 0;
  const jour0 = today();
  revs.sort(
    (a, b) =>
      (b.statut === 'reportee') - (a.statut === 'reportee') ||
      Number(b.coef) - Number(a.coef) ||
      a.indexPalier - b.indexPalier ||
      String(a.dateCours).localeCompare(String(b.dateCours))
  );
  const charge = new Map();
  for (const r of revs) {
    const duree = r.dureeEstimeeMin > 0 ? r.dureeEstimeeMin : dureeRevision(r.niveauCharge || 'moyen', r.indexPalier);
    let ideal = String(r.dueLeIdeal || r.dueLe).slice(0, 10);
    if (ideal < jour0) ideal = jour0;
    const { dueLe } = placer(ideal, duree, budget, charge, deriveMax(r.indexPalier));
    charge.set(dueLe, (charge.get(dueLe) || 0) + duree);
    await db.query('UPDATE mm_revision SET dueLe = ?, dureeEstimeeMin = ? WHERE id = ?', [dueLe, duree, r.id]);
  }
  return revs.length;
}

module.exports = {
  genererRevisions,
  lirePaliers,
  lireBudget,
  chargeParJour,
  placer,
  addDaysISO,
  majDureesCours,
  recalculerPlanning,
};
