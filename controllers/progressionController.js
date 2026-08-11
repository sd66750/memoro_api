// Progression (indicateurs globaux, maîtrise par matière, charge 7 jours),
// paramètres (paliers J, mode exigeant, seuil QCM, plafond) et composition de la
// révision libre (tirage pondéré).
const db = require('../config/db').promise();
const { maitriseParCours } = require('../services/maitrise');
const { daysDiff } = require('../utils/dates');

exports.getProgression = async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [[cours]] = await db.query('SELECT COUNT(*) AS n FROM mm_cours WHERE idUtilisateur = ?', [uid]);
    const [[manquants]] = await db.query(
      'SELECT COUNT(*) AS n FROM mm_cours c WHERE idUtilisateur = ? AND NOT EXISTS (SELECT 1 FROM mm_support s WHERE s.idCours = c.id AND s.estCourant = 1)',
      [uid]
    );
    const [[revDue]] = await db.query(
      "SELECT COUNT(*) AS n FROM mm_revision WHERE idUtilisateur = ? AND statut IN ('due','reportee') AND dueLe <= CURDATE()",
      [uid]
    );
    const [[cartesDue]] = await db.query(
      'SELECT COUNT(*) AS n FROM mm_carte_etat WHERE idUtilisateur = ? AND dueLe IS NOT NULL AND dueLe <= CURDATE()',
      [uid]
    );

    const parCours = await maitriseParCours(uid);
    const vals = [...parCours.values()];
    const maitriseGlobale = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;

    const [coursMat] = await db.query('SELECT id, idMatiere FROM mm_cours WHERE idUtilisateur = ?', [uid]);
    const [mats] = await db.query('SELECT id, libelle, couleur, coefficient FROM mm_matiere WHERE idUtilisateur = ? ORDER BY ordre, libelle', [uid]);
    const parMat = new Map();
    for (const c of coursMat) {
      if (c.idMatiere == null) continue;
      const v = parCours.get(c.id);
      if (v == null) continue;
      if (!parMat.has(c.idMatiere)) parMat.set(c.idMatiere, []);
      parMat.get(c.idMatiere).push(v);
    }
    const maitriseParMatiere = mats.map((mt) => {
      const arr = parMat.get(mt.id) || [];
      const moy = arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;
      return { id: mt.id, libelle: mt.libelle, couleur: mt.couleur, maitrise: moy, nbCours: coursMat.filter((c) => c.idMatiere === mt.id).length };
    });

    const [charge7j] = await db.query(
      "SELECT dueLe, COUNT(*) AS n FROM mm_revision WHERE idUtilisateur = ? AND statut IN ('due','reportee') AND dueLe BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 6 DAY) GROUP BY dueLe ORDER BY dueLe",
      [uid]
    );

    const [prm] = await db.query('SELECT paliersJson, modeExigeant, seuilQcm, plafondQuotidien FROM mm_parametre WHERE idUtilisateur = ?', [uid]);
    let paliers = [1, 3, 7, 14, 30];
    const raw = prm[0]?.paliersJson;
    if (raw) { try { const p = typeof raw === 'string' ? JSON.parse(raw) : raw; if (Array.isArray(p)) paliers = p; } catch { /* défaut */ } }

    res.json({
      indicateurs: { cours: cours.n, supportsManquants: manquants.n, revisionsDue: revDue.n, cartesDue: cartesDue.n, maitriseGlobale },
      maitriseParMatiere,
      charge7j,
      parametres: {
        paliers,
        modeExigeant: prm[0]?.modeExigeant ? 1 : 0,
        seuilQcm: prm[0]?.seuilQcm ?? 70,
        plafondQuotidien: prm[0]?.plafondQuotidien ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateParametres = async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { paliers, modeExigeant, seuilQcm, plafondQuotidien } = req.body || {};
    const paliersJson = Array.isArray(paliers)
      ? JSON.stringify(paliers.map(Number).filter((n) => Number.isFinite(n) && n > 0))
      : null;
    await db.query(
      `INSERT INTO mm_parametre (idUtilisateur, paliersJson, modeExigeant, seuilQcm, plafondQuotidien)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         paliersJson = COALESCE(VALUES(paliersJson), paliersJson),
         modeExigeant = VALUES(modeExigeant),
         seuilQcm = VALUES(seuilQcm),
         plafondQuotidien = VALUES(plafondQuotidien)`,
      [
        uid,
        paliersJson || '[1,3,7,14,30]',
        modeExigeant ? 1 : 0,
        seuilQcm != null ? Number(seuilQcm) : 70,
        plafondQuotidien != null && plafondQuotidien !== '' ? Number(plafondQuotidien) : null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// Tirage pondéré (maîtrise basse via retard d'échéance, ancienneté). La révision
// libre ne modifie AUCUNE échéance : c'est une session d'entraînement.
function poidsCarte(r) {
  let w = 1;
  if (!r.dueLe) w += 2; // jamais vue
  else { const retard = daysDiff(r.dueLe); if (retard >= 0) w += Math.min(3, 1 + retard * 0.2); }
  if (!r.revueLe) w += 1;
  return w;
}
function tirer(items, k) {
  const pool = items.slice();
  const out = [];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const total = pool.reduce((a, b) => a + (b.__w || 1), 0);
    let x = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) { x -= pool[idx].__w || 1; if (x <= 0) break; }
    const [picked] = pool.splice(Math.min(idx, pool.length - 1), 1);
    const { __w, ...rest } = picked;
    void __w;
    out.push(rest);
  }
  return out;
}

exports.revisionLibre = async (req, res, next) => {
  try {
    const uid = req.user.id;
    const { type = 'mixte', matieres = [], nombre = 15 } = req.body || {};
    const n = Math.min(50, Math.max(1, Number(nombre) || 15));
    const matFilter = Array.isArray(matieres) && matieres.length ? matieres.map(Number) : null;

    let cartes = [];
    if (type === 'cartes' || type === 'mixte') {
      const params = [uid, uid];
      let sql = `SELECT ca.id, ca.recto, ca.verso, ca.diapo, ca.idCours, c.idMatiere, e.dueLe, e.revueLe
                   FROM mm_carte ca
                   JOIN mm_support s ON s.id = ca.idSupport AND s.estCourant = 1
                   JOIN mm_cours c ON c.id = ca.idCours AND c.idUtilisateur = ?
                   LEFT JOIN mm_carte_etat e ON e.idCarte = ca.id AND e.idUtilisateur = ?`;
      if (matFilter) { sql += ' WHERE c.idMatiere IN (?)'; params.push(matFilter); }
      const [rows] = await db.query(sql, params);
      cartes = tirer(rows.map((r) => ({ ...r, __w: poidsCarte(r) })), type === 'mixte' ? Math.ceil(n / 2) : n);
    }

    let questions = [];
    if (type === 'qcm' || type === 'mixte') {
      const params = [uid];
      let sql = `SELECT q.id, q.enonce, q.idQcm, qc.idCours, c.idMatiere
                   FROM mm_qcm_question q
                   JOIN mm_qcm qc ON qc.id = q.idQcm
                   JOIN mm_support s ON s.id = qc.idSupport AND s.estCourant = 1
                   JOIN mm_cours c ON c.id = qc.idCours AND c.idUtilisateur = ?`;
      if (matFilter) { sql += ' WHERE c.idMatiere IN (?)'; params.push(matFilter); }
      const [rows] = await db.query(sql, params);
      const chosen = tirer(rows.map((r) => ({ ...r, __w: 1 })), type === 'mixte' ? Math.floor(n / 2) : n);
      const ids = chosen.map((x) => x.id);
      let props = [];
      if (ids.length) {
        const [p] = await db.query('SELECT id, idQuestion, lettre, texte FROM mm_qcm_proposition WHERE idQuestion IN (?)', [ids]);
        props = p;
      }
      const byQ = {};
      for (const p of props) (byQ[p.idQuestion] ??= []).push({ id: p.id, lettre: p.lettre, texte: p.texte });
      questions = chosen.map((x) => ({ id: x.id, enonce: x.enonce, idQcm: x.idQcm, propositions: byQ[x.id] || [] }));
    }

    res.json({ cartes, questions });
  } catch (err) {
    next(err);
  }
};

// Correction d'une session QCM libre (questions de cours variés). Persiste une
// tentative partielle par QCM (compte dans la maîtrise) mais ne touche AUCUNE
// échéance de révision (brief §6).
exports.soumettreLibre = async (req, res, next) => {
  try {
    const uid = req.user.id;
    const list = Array.isArray(req.body?.reponses) ? req.body.reponses : [];
    const qids = list.map((r) => Number(r.idQuestion)).filter(Boolean);
    if (!qids.length) return res.json({ score: 0, total: 0, pourcentage: 0, correction: [] });

    const [qrows] = await db.query(
      `SELECT q.id AS idQuestion, q.idQcm, qc.idCours
         FROM mm_qcm_question q
         JOIN mm_qcm qc ON qc.id = q.idQcm
         JOIN mm_cours c ON c.id = qc.idCours AND c.idUtilisateur = ?
        WHERE q.id IN (?)`,
      [uid, qids]
    );
    const okIds = new Set(qrows.map((r) => r.idQuestion));
    if (!okIds.size) return res.json({ score: 0, total: 0, pourcentage: 0, correction: [] });
    const qMeta = new Map(qrows.map((r) => [r.idQuestion, r]));

    const [props] = await db.query('SELECT id, idQuestion, lettre, estCorrecte, explication, diapo FROM mm_qcm_proposition WHERE idQuestion IN (?)', [[...okIds]]);
    const byQ = {};
    for (const p of props) (byQ[p.idQuestion] ??= []).push(p);

    const repMap = {};
    for (const r of list) if (okIds.has(Number(r.idQuestion))) repMap[Number(r.idQuestion)] = (r.lettres || []).slice().sort().join('');

    let score = 0;
    const correction = [];
    const groupes = new Map(); // idQcm -> { idCours, correct, total }
    for (const idQuestion of okIds) {
      const ps = byQ[idQuestion] || [];
      const bonnes = ps.filter((p) => p.estCorrecte).map((p) => p.lettre).sort().join('');
      const saisie = repMap[idQuestion] || '';
      const ok = saisie !== '' && saisie === bonnes;
      if (ok) score++;
      correction.push({
        idQuestion,
        correcte: ok,
        bonnesLettres: bonnes.split('').filter(Boolean),
        propositions: ps.map((p) => ({ id: p.id, lettre: p.lettre, estCorrecte: !!p.estCorrecte, explication: p.explication, diapo: p.diapo })),
      });
      const meta = qMeta.get(idQuestion);
      const g = groupes.get(meta.idQcm) || { idCours: meta.idCours, correct: 0, total: 0 };
      g.total++;
      if (ok) g.correct++;
      groupes.set(meta.idQcm, g);
    }

    for (const [idQcm, g] of groupes) {
      const pct = g.total ? Math.round((g.correct / g.total) * 10000) / 100 : 0;
      await db.query(
        `INSERT INTO mm_qcm_tentative (idUtilisateur, idQcm, idCours, palier, finLe, scoreObtenu, scoreTotal, pourcentage, surSupportArchive)
         VALUES (?,?,?,NULL,NOW(),?,?,?,0)`,
        [uid, idQcm, g.idCours, g.correct, g.total, pct]
      );
    }

    const total = okIds.size;
    res.json({ score, total, pourcentage: total ? Math.round((score / total) * 10000) / 100 : 0, correction });
  } catch (err) {
    next(err);
  }
};
