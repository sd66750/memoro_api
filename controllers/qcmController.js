// Soumission d'une tentative de QCM : correction (une proposition juste = tout ou
// rien par question), score, enregistrement de la tentative et des réponses.
const db = require('../config/db').promise();

// Questions d'un QCM précis (sans les réponses), pour le passer. Cloisonné utilisateur.
exports.take = async (req, res, next) => {
  try {
    const idQcm = Number(req.params.id);
    const [q] = await db.query(
      `SELECT qc.id FROM mm_qcm qc
         JOIN mm_cours c ON c.id = qc.idCours AND c.idUtilisateur = ?
        WHERE qc.id = ?`,
      [req.user.id, idQcm]
    );
    if (!q.length) return res.status(404).json({ error: 'QCM introuvable.' });
    const [questions] = await db.query('SELECT id, enonce, ordre FROM mm_qcm_question WHERE idQcm = ? ORDER BY ordre, id', [idQcm]);
    const ids = questions.map((x) => x.id);
    let props = [];
    if (ids.length) {
      const [p] = await db.query('SELECT id, idQuestion, lettre, texte FROM mm_qcm_proposition WHERE idQuestion IN (?) ORDER BY idQuestion, lettre', [ids]);
      props = p;
    }
    const byQ = {};
    for (const p of props) (byQ[p.idQuestion] ??= []).push({ id: p.id, lettre: p.lettre, texte: p.texte });
    res.json({ id: idQcm, questions: questions.map((x) => ({ id: x.id, enonce: x.enonce, propositions: byQ[x.id] || [] })) });
  } catch (err) {
    next(err);
  }
};

exports.soumettre = async (req, res, next) => {
  try {
    const idQcm = Number(req.params.id);
    const { reponses, palier } = req.body || {};

    const [q] = await db.query(
      `SELECT qc.id, qc.idCours, s.estCourant
         FROM mm_qcm qc
         JOIN mm_support s ON s.id = qc.idSupport
         JOIN mm_cours c ON c.id = qc.idCours AND c.idUtilisateur = ?
        WHERE qc.id = ?`,
      [req.user.id, idQcm]
    );
    if (!q.length) return res.status(404).json({ error: 'QCM introuvable.' });
    const idCours = q[0].idCours;
    const surSupportArchive = q[0].estCourant ? 0 : 1;

    const [questions] = await db.query('SELECT id FROM mm_qcm_question WHERE idQcm = ?', [idQcm]);
    const qids = questions.map((x) => x.id);
    let props = [];
    if (qids.length) {
      const [p] = await db.query('SELECT id, idQuestion, lettre, estCorrecte, explication, diapo FROM mm_qcm_proposition WHERE idQuestion IN (?)', [qids]);
      props = p;
    }
    const byQ = {};
    for (const p of props) (byQ[p.idQuestion] ??= []).push(p);

    const repMap = {};
    for (const r of reponses || []) repMap[r.idQuestion] = (r.lettres || []).slice().sort().join('');

    let score = 0;
    const correction = [];
    for (const ques of questions) {
      const ps = byQ[ques.id] || [];
      const bonnes = ps.filter((p) => p.estCorrecte).map((p) => p.lettre).sort().join('');
      const saisie = repMap[ques.id] || '';
      const ok = saisie !== '' && saisie === bonnes;
      if (ok) score++;
      correction.push({
        idQuestion: ques.id,
        correcte: ok,
        bonnesLettres: bonnes.split('').filter(Boolean),
        propositions: ps.map((p) => ({ id: p.id, lettre: p.lettre, estCorrecte: !!p.estCorrecte, explication: p.explication, diapo: p.diapo })),
      });
    }

    const total = questions.length;
    const pourcentage = total ? Math.round((score / total) * 10000) / 100 : 0;

    const [ins] = await db.query(
      `INSERT INTO mm_qcm_tentative (idUtilisateur, idQcm, idCours, palier, finLe, scoreObtenu, scoreTotal, pourcentage, surSupportArchive)
       VALUES (?,?,?,?,NOW(),?,?,?,?)`,
      [req.user.id, idQcm, idCours, palier ?? null, score, total, pourcentage, surSupportArchive]
    );
    const idTentative = ins.insertId;
    for (const ques of questions) {
      const saisie = repMap[ques.id] || '';
      const ps = byQ[ques.id] || [];
      const bonnes = ps.filter((p) => p.estCorrecte).map((p) => p.lettre).sort().join('');
      const ok = saisie !== '' && saisie === bonnes;
      await db.query('INSERT INTO mm_qcm_reponse (idTentative, idQuestion, lettresCochees, estCorrecte) VALUES (?,?,?,?)', [idTentative, ques.id, saisie || null, ok ? 1 : 0]);
    }

    res.json({ idTentative, score, total, pourcentage, surSupportArchive, correction });
  } catch (err) {
    next(err);
  }
};
