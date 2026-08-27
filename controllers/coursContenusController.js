// Lecture des contenus d'un cours (page de cours) : en-tête + paliers, fiche de
// synthèse, cartes mémo (avec état d'apprentissage), QCM (sans les réponses, pour
// une mesure honnête), et historique des tentatives.
const path = require('path');
const db = require('../config/db').promise();
const { maitriseParCours } = require('../services/maitrise');
const { genererQcm, hasKey } = require('../services/generation');

async function possede(idUtilisateur, idCours) {
  const [rows] = await db.query('SELECT id FROM mm_cours WHERE id = ? AND idUtilisateur = ?', [idCours, idUtilisateur]);
  return rows.length > 0;
}

exports.getEntete = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [c] = await db.query(
      `SELECT c.id, c.titre, c.professeur, c.dateCours, c.heureDebut, c.heureFin, c.salle, c.idMatiere, c.niveauCharge,
              m.libelle AS matiereLibelle, m.couleur AS matiereCouleur, m.code AS matiereCode
         FROM mm_cours c LEFT JOIN mm_matiere m ON m.id = c.idMatiere
        WHERE c.id = ? AND c.idUtilisateur = ?`,
      [id, req.user.id]
    );
    if (!c.length) return res.status(404).json({ error: 'Cours introuvable.' });

    const [sup] = await db.query(
      'SELECT id, nomFichier, nbPages, tailleOctets, anthropicFileId, deposeLe, cheminStockage FROM mm_support WHERE idCours = ? AND estCourant = 1 LIMIT 1',
      [id]
    );
    const support = sup[0] || null;
    if (support) {
      // Nom de fichier stocké (non devinable) pour un service direct par nginx
      // depuis le disque (contourne le transfert lent à travers le proxy).
      support.fichierStocke = path.basename(support.cheminStockage || '');
      delete support.cheminStockage; // ne pas exposer le chemin disque complet
    }

    const [revisions] = await db.query(
      "SELECT id, indexPalier, dueLe, dueLeIdeal, dureeEstimeeMin, statut, faitLe FROM mm_revision WHERE idCours = ? ORDER BY indexPalier",
      [id]
    );

    let aSynthese = 0;
    let nbCartes = 0;
    let aQcm = 0;
    if (support) {
      const [[s]] = await db.query('SELECT COUNT(*) AS n FROM mm_synthese WHERE idSupport = ?', [support.id]);
      const [[cc]] = await db.query('SELECT COUNT(*) AS n FROM mm_carte WHERE idSupport = ?', [support.id]);
      const [[qq]] = await db.query('SELECT COUNT(*) AS n FROM mm_qcm WHERE idSupport = ?', [support.id]);
      aSynthese = s.n > 0 ? 1 : 0;
      nbCartes = cc.n;
      aQcm = qq.n > 0 ? 1 : 0;
    }

    const maitrise = (await maitriseParCours(req.user.id)).get(id) ?? null;
    const [[nt]] = await db.query('SELECT COUNT(*) AS n FROM mm_qcm_tentative WHERE idCours = ?', [id]);
    let paliers = [1, 3, 7, 14, 30];
    const [prm] = await db.query('SELECT paliersJson FROM mm_parametre WHERE idUtilisateur = ?', [req.user.id]);
    if (prm[0]?.paliersJson) { try { const p = typeof prm[0].paliersJson === 'string' ? JSON.parse(prm[0].paliersJson) : prm[0].paliersJson; if (Array.isArray(p)) paliers = p; } catch { /* défaut */ } }
    res.json({ cours: c[0], support, revisions, aSynthese, nbCartes, aQcm, maitrise, paliers, nbTentatives: nt.n });
  } catch (err) {
    next(err);
  }
};

exports.getSynthese = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await possede(req.user.id, id))) return res.status(404).json({ error: 'Cours introuvable.' });
    const [rows] = await db.query(
      `SELECT sy.contenuJson, sy.genereLe
         FROM mm_synthese sy
         JOIN mm_support s ON s.id = sy.idSupport AND s.estCourant = 1
        WHERE sy.idCours = ? ORDER BY sy.genereLe DESC LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.json(null);
    let contenu = rows[0].contenuJson;
    if (typeof contenu === 'string') { try { contenu = JSON.parse(contenu); } catch { /* garde brut */ } }
    res.json({ contenu, genereLe: rows[0].genereLe });
  } catch (err) {
    next(err);
  }
};

exports.getCartes = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await possede(req.user.id, id))) return res.status(404).json({ error: 'Cours introuvable.' });
    const [rows] = await db.query(
      `SELECT ca.id, ca.recto, ca.verso, ca.diapo,
              e.etat, e.intervalleJours, e.facilite, e.dueLe, e.derniereNote, e.revueLe
         FROM mm_carte ca
         JOIN mm_support s ON s.id = ca.idSupport AND s.estCourant = 1
         LEFT JOIN mm_carte_etat e ON e.idCarte = ca.id AND e.idUtilisateur = ?
        WHERE ca.idCours = ? ORDER BY ca.id`,
      [req.user.id, id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

exports.getQcm = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await possede(req.user.id, id))) return res.status(404).json({ error: 'Cours introuvable.' });
    const [q] = await db.query(
      `SELECT qc.id FROM mm_qcm qc
         JOIN mm_support s ON s.id = qc.idSupport AND s.estCourant = 1
        WHERE qc.idCours = ? ORDER BY qc.genereLe DESC LIMIT 1`,
      [id]
    );
    if (!q.length) return res.json(null);
    const idQcm = q[0].id;
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

exports.getQcmHistorique = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await possede(req.user.id, id))) return res.status(404).json({ error: 'Cours introuvable.' });
    // Filtre optionnel par QCM (?idQcm=) pour l'historique d'un cartouche précis.
    const idQcm = req.query.idQcm ? Number(req.query.idQcm) : null;
    const params = [id, req.user.id];
    let filtre = '';
    if (idQcm) { filtre = 'AND idQcm = ?'; params.push(idQcm); }
    const [rows] = await db.query(
      `SELECT id, idQcm, palier, finLe, pourcentage, scoreObtenu, scoreTotal, surSupportArchive
         FROM mm_qcm_tentative WHERE idCours = ? AND idUtilisateur = ? ${filtre}
        ORDER BY finLe DESC LIMIT 20`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

// Liste des QCM du support courant, avec date, nb de tentatives et score max
// (cartouches de l'onglet QCM). Le plus récent en premier.
exports.getQcmListe = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await possede(req.user.id, id))) return res.status(404).json({ error: 'Cours introuvable.' });
    const [rows] = await db.query(
      `SELECT qc.id, qc.genereLe,
              COUNT(t.id) AS nbTentatives,
              MAX(t.pourcentage) AS scoreMax
         FROM mm_qcm qc
         JOIN mm_support s ON s.id = qc.idSupport AND s.estCourant = 1
         LEFT JOIN mm_qcm_tentative t ON t.idQcm = qc.id AND t.idUtilisateur = ?
        WHERE qc.idCours = ?
        GROUP BY qc.id, qc.genereLe
        ORDER BY qc.genereLe DESC, qc.id DESC`,
      [req.user.id, id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

// Génère un QCM supplémentaire sur le support courant (garde les anciens). Synchrone.
exports.genererNouveauQcm = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await possede(req.user.id, id))) return res.status(404).json({ error: 'Cours introuvable.' });
    if (!hasKey()) return res.status(400).json({ error: 'Génération IA indisponible (clé Anthropic absente).' });
    const [sup] = await db.query(
      'SELECT id, idCours, cheminStockage, anthropicFileId FROM mm_support WHERE idCours = ? AND estCourant = 1 LIMIT 1',
      [id]
    );
    if (!sup.length) return res.status(400).json({ error: "Aucun support : dépose d'abord un PDF." });
    const idQcm = await genererQcm(sup[0]);
    const [[row]] = await db.query('SELECT genereLe FROM mm_qcm WHERE id = ?', [idQcm]);
    res.status(201).json({ id: idQcm, genereLe: row?.genereLe ?? null });
  } catch (err) {
    console.error('Génération nouveau QCM KO:', err.message);
    res.status(500).json({ error: 'La génération du QCM a échoué. Réessaie.' });
  }
};
