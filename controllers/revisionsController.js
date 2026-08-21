// Révisions / écran Aujourd'hui + validation depuis la page du cours + report.
const db = require('../config/db').promise();
const { maitriseParCours } = require('../services/maitrise');
const { halveFromToday, calcStreak } = require('../utils/dates');
const { lireBudget, chargeParJour, placer, addDaysISO, recalculerPlanning } = require('../services/paliers');
const { deriveMax } = require('../services/charge');

exports.getAujourdhui = async (req, res, next) => {
  try {
    const uid = req.user.id;

    // Report : une révision due non faite passe en reportée (jamais perdue).
    await db.query(
      "UPDATE mm_revision SET statut = 'reportee', reportDepuis = COALESCE(reportDepuis, dueLe) WHERE idUtilisateur = ? AND statut = 'due' AND dueLe < CURDATE()",
      [uid]
    );

    const [aujourdhui] = await db.query(
      `SELECT r.id, r.idCours, r.indexPalier, r.dueLe, r.dueLeIdeal, r.dureeEstimeeMin, r.statut, r.reportDepuis,
              c.titre, c.dateCours, c.professeur, m.libelle AS matiereLibelle, m.couleur AS matiereCouleur, m.code AS matiereCode
         FROM mm_revision r
         JOIN mm_cours c ON c.id = r.idCours
         LEFT JOIN mm_matiere m ON m.id = c.idMatiere
        WHERE r.idUtilisateur = ? AND r.statut IN ('due','reportee') AND r.dueLe <= CURDATE()
        ORDER BY (r.statut = 'reportee') DESC, COALESCE(m.coefficient, 1) DESC, r.indexPalier, r.dueLe, c.titre`,
      [uid]
    );

    const [[demain]] = await db.query(
      "SELECT COUNT(*) AS n FROM mm_revision WHERE idUtilisateur = ? AND statut = 'due' AND dueLe = DATE_ADD(CURDATE(), INTERVAL 1 DAY)",
      [uid]
    );

    const [supportsManquants] = await db.query(
      `SELECT c.id, c.titre, c.dateCours, m.libelle AS matiereLibelle, m.couleur AS matiereCouleur
         FROM mm_cours c LEFT JOIN mm_matiere m ON m.id = c.idMatiere
        WHERE c.idUtilisateur = ? AND NOT EXISTS (SELECT 1 FROM mm_support s WHERE s.idCours = c.id AND s.estCourant = 1)
        ORDER BY c.dateCours DESC LIMIT 10`,
      [uid]
    );

    // Matières fragiles : les 3 plus basses maîtrises.
    const parCours = await maitriseParCours(uid);
    const [coursMat] = await db.query('SELECT id, idMatiere FROM mm_cours WHERE idUtilisateur = ?', [uid]);
    const [mats] = await db.query('SELECT id, libelle, couleur FROM mm_matiere WHERE idUtilisateur = ?', [uid]);
    const parMat = new Map();
    for (const c of coursMat) {
      if (c.idMatiere == null) continue;
      const v = parCours.get(c.id);
      if (v == null) continue;
      if (!parMat.has(c.idMatiere)) parMat.set(c.idMatiere, []);
      parMat.get(c.idMatiere).push(v);
    }
    const matieresFragiles = mats
      .map((mt) => {
        const arr = parMat.get(mt.id) || [];
        const moy = arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;
        return { id: mt.id, libelle: mt.libelle, couleur: mt.couleur, maitrise: moy };
      })
      .filter((x) => x.maitrise != null)
      .sort((a, b) => a.maitrise - b.maitrise)
      .slice(0, 3);

    const [faites] = await db.query(
      "SELECT DISTINCT DATE(faitLe) AS j FROM mm_revision WHERE idUtilisateur = ? AND statut = 'faite' AND faitLe IS NOT NULL ORDER BY j DESC LIMIT 400",
      [uid]
    );
    const serie = calcStreak(faites.map((r) => r.j));

    // Paliers (pour libeller J+jour), révisions faites aujourd'hui, matière dominante de demain.
    let paliers = [1, 3, 7, 14, 30];
    const [prm] = await db.query('SELECT paliersJson FROM mm_parametre WHERE idUtilisateur = ?', [uid]);
    if (prm[0]?.paliersJson) { try { const p = typeof prm[0].paliersJson === 'string' ? JSON.parse(prm[0].paliersJson) : prm[0].paliersJson; if (Array.isArray(p)) paliers = p; } catch { /* défaut */ } }
    const [[fj]] = await db.query("SELECT COUNT(*) AS n FROM mm_revision WHERE idUtilisateur = ? AND statut = 'faite' AND DATE(faitLe) = CURDATE()", [uid]);
    const [dm] = await db.query(
      `SELECT m.libelle, m.couleur, COUNT(*) AS n
         FROM mm_revision r JOIN mm_cours c ON c.id = r.idCours LEFT JOIN mm_matiere m ON m.id = c.idMatiere
        WHERE r.idUtilisateur = ? AND r.statut = 'due' AND r.dueLe = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        GROUP BY m.id ORDER BY n DESC LIMIT 1`,
      [uid]
    );
    const items = aujourdhui.map((r) => ({ ...r, maitrise: parCours.get(r.idCours) ?? null }));

    // Budget d'absorption : temps restant du jour vs budget, temps déjà fait,
    // et alerte de surcharge structurelle sur les 7 prochains jours.
    const budgetMin = await lireBudget(uid);
    const chargeMin = items.reduce((s, r) => s + (Number(r.dureeEstimeeMin) || 0), 0);
    const [[fm]] = await db.query(
      "SELECT COALESCE(SUM(dureeEstimeeMin),0) AS min FROM mm_revision WHERE idUtilisateur = ? AND statut = 'faite' AND DATE(faitLe) = CURDATE()",
      [uid]
    );
    const faitMin = Number(fm.min) || 0;
    const [charge7j] = await db.query(
      "SELECT dueLe, SUM(dureeEstimeeMin) AS min FROM mm_revision WHERE idUtilisateur = ? AND statut IN ('due','reportee') AND dueLe BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 6 DAY) GROUP BY dueLe",
      [uid]
    );
    const total7 = charge7j.reduce((s, r) => s + (Number(r.min) || 0), 0);
    const capacite7 = budgetMin * 7;
    const joursSatures = charge7j.filter((r) => Number(r.min) > budgetMin).length;
    const surcharge = total7 > capacite7 || joursSatures > 0
      ? { chargeMin: total7, capaciteMin: capacite7, joursSatures }
      : null;

    res.json({
      aujourdhui: items,
      demain: demain.n,
      demainMatiere: dm[0] && dm[0].libelle ? { libelle: dm[0].libelle, couleur: dm[0].couleur, n: dm[0].n } : null,
      faitesAujourdhui: fj.n,
      budgetMin,
      chargeMin,
      faitMin,
      surcharge,
      paliers,
      supportsManquants,
      matieresFragiles,
      serie,
    });
  } catch (err) {
    next(err);
  }
};

// Validation d'un palier — UNIQUEMENT depuis la page du cours (brief §6).
exports.valider = async (req, res, next) => {
  try {
    const uid = req.user.id;
    const idCours = Number(req.params.idCours);
    const [own] = await db.query('SELECT id FROM mm_cours WHERE id = ? AND idUtilisateur = ?', [idCours, uid]);
    if (!own.length) return res.status(404).json({ error: 'Cours introuvable.' });

    const [prm] = await db.query('SELECT modeExigeant, seuilQcm FROM mm_parametre WHERE idUtilisateur = ?', [uid]);
    const modeExigeant = prm[0]?.modeExigeant ? 1 : 0;
    const seuil = prm[0]?.seuilQcm ?? 70;

    // Dernière tentative QCM du jour (support courant) pour ce cours.
    const [derniere] = await db.query(
      "SELECT pourcentage FROM mm_qcm_tentative WHERE idUtilisateur = ? AND idCours = ? AND surSupportArchive = 0 AND DATE(finLe) = CURDATE() ORDER BY finLe DESC LIMIT 1",
      [uid, idCours]
    );
    const pctJour = derniere.length ? Number(derniere[0].pourcentage) : null;

    if (modeExigeant && (pctJour == null || pctJour < seuil)) {
      return res.status(409).json({
        error: `Mode exigeant : un QCM à ${seuil}% ou plus est requis (obtenu aujourd'hui : ${pctJour == null ? 'aucun' : pctJour + '%'}).`,
      });
    }

    const [rev] = await db.query(
      "SELECT id, indexPalier, dueLe FROM mm_revision WHERE idUtilisateur = ? AND idCours = ? AND statut IN ('due','reportee') AND dueLe <= CURDATE() ORDER BY dueLe LIMIT 1",
      [uid, idCours]
    );
    if (!rev.length) return res.status(400).json({ error: "Aucune révision à valider aujourd'hui pour ce cours." });

    await db.query("UPDATE mm_revision SET statut = 'faite', faitLe = NOW() WHERE id = ?", [rev[0].id]);

    // Le score module le palier : < 50 % → l'échéance suivante est rapprochée de
    // moitié, puis replacée sous budget (le rattrapage ne doit pas recréer un pic).
    if (pctJour != null && pctJour < 50) {
      const [next] = await db.query(
        "SELECT id, dueLe, indexPalier, dureeEstimeeMin FROM mm_revision WHERE idUtilisateur = ? AND idCours = ? AND indexPalier > ? AND statut = 'due' ORDER BY indexPalier LIMIT 1",
        [uid, idCours, rev[0].indexPalier]
      );
      if (next.length) {
        const nd = halveFromToday(next[0].dueLe);
        const dm = deriveMax(next[0].indexPalier);
        const charge = await chargeParJour(uid, nd, addDaysISO(nd, dm));
        const { dueLe } = placer(nd, Number(next[0].dureeEstimeeMin) || 0, await lireBudget(uid), charge, dm);
        await db.query('UPDATE mm_revision SET dueLe = ? WHERE id = ?', [dueLe, next[0].id]);
      }
    }

    res.json({ ok: true, idRevision: rev[0].id, pourcentageQcm: pctJour });
  } catch (err) {
    next(err);
  }
};

// Recalcule (replace) le futur sous budget — lissage à la demande. Passé/fait figés.
exports.recalculer = async (req, res, next) => {
  try {
    const n = await recalculerPlanning(req.user.id);
    res.json({ ok: true, replanifiees: n });
  } catch (err) {
    next(err);
  }
};
