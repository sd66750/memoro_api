// Cours — CRUD cloisonné par utilisateur + liste par plage de dates (agenda) +
// duplication d'une semaine sur l'autre (brief §8). Un cours peut exister sans
// support ; aSupport indique s'il possède un PDF courant.
const fs = require('fs');
const db = require('../config/db');
const dbp = db.promise();
const { majDureesCours } = require('../services/paliers');

const NIVEAUX = ['leger', 'moyen', 'dense', 'tres_dense'];

const SELECT_BASE = `
  SELECT c.id, c.idMatiere, c.titre, c.professeur, c.dateCours, c.heureDebut, c.heureFin, c.salle, c.niveauCharge,
         m.libelle AS matiereLibelle, m.couleur AS matiereCouleur, m.code AS matiereCode,
         EXISTS(SELECT 1 FROM mm_support s WHERE s.idCours = c.id AND s.estCourant = 1) AS aSupport
    FROM mm_cours c
    LEFT JOIN mm_matiere m ON m.id = c.idMatiere`;

exports.getAll = (req, res, next) => {
  const { from, to } = req.query;
  const params = [req.user.id];
  let where = 'c.idUtilisateur = ?';
  if (from && to) { where += ' AND c.dateCours BETWEEN ? AND ?'; params.push(from, to); }
  const sql = `${SELECT_BASE} WHERE ${where} ORDER BY c.dateCours, c.heureDebut`;
  db.query(sql, params, (err, data) => {
    if (err) return next(err);
    res.json(data);
  });
};

exports.getById = (req, res, next) => {
  const sql = `${SELECT_BASE} WHERE c.id = ? AND c.idUtilisateur = ?`;
  db.query(sql, [req.params.id, req.user.id], (err, data) => {
    if (err) return next(err);
    if (!data.length) return res.status(404).json({ error: 'Cours introuvable.' });
    res.json(data[0]);
  });
};

exports.create = (req, res, next) => {
  const { idMatiere, titre, professeur, dateCours, heureDebut, heureFin, salle, niveauCharge } = req.body || {};
  if (!titre || !dateCours) return res.status(400).json({ error: 'Titre et date obligatoires.' });
  const niveau = NIVEAUX.includes(niveauCharge) ? niveauCharge : 'moyen';
  const sql = `INSERT INTO mm_cours (idUtilisateur, idMatiere, titre, professeur, dateCours, heureDebut, heureFin, salle, niveauCharge)
               VALUES (?,?,?,?,?,?,?,?,?)`;
  const params = [req.user.id, idMatiere || null, titre, professeur || null, dateCours, heureDebut || null, heureFin || null, salle || null, niveau];
  db.query(sql, params, (err, result) => {
    if (err) return next(err);
    res.status(201).json({ id: result.insertId });
  });
};

exports.update = (req, res, next) => {
  const { idMatiere, titre, professeur, dateCours, heureDebut, heureFin, salle, niveauCharge } = req.body || {};
  if (!titre || !dateCours) return res.status(400).json({ error: 'Titre et date obligatoires.' });
  const niveau = NIVEAUX.includes(niveauCharge) ? niveauCharge : null; // null => on ne change pas le niveau
  const sql = `UPDATE mm_cours
                  SET idMatiere = ?, titre = ?, professeur = ?, dateCours = ?, heureDebut = ?, heureFin = ?, salle = ?${niveau ? ', niveauCharge = ?' : ''}
                WHERE id = ? AND idUtilisateur = ?`;
  const params = [idMatiere || null, titre, professeur || null, dateCours, heureDebut || null, heureFin || null, salle || null];
  if (niveau) params.push(niveau);
  params.push(req.params.id, req.user.id);
  db.query(sql, params, (err, result) => {
    if (err) return next(err);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Cours introuvable.' });
    // Changement de niveau : réévalue la durée estimée des révisions non faites
    // (le replacement effectif se fait via « recalculer le planning »).
    if (niveau) {
      majDureesCours(req.user.id, Number(req.params.id), niveau)
        .then(() => res.json({ ok: true }))
        .catch(next);
    } else {
      res.json({ ok: true });
    }
  });
};

exports.remove = async (req, res, next) => {
  try {
    // Récupère les fichiers PDF du cours AVANT le DELETE : la BDD est nettoyée en
    // cascade par les FK (supports, révisions, cartes, QCM, synthèses), mais pas les
    // fichiers sur le disque — on les efface nous-mêmes pour éviter les orphelins.
    const [supports] = await dbp.query(
      'SELECT s.cheminStockage FROM mm_support s JOIN mm_cours c ON c.id = s.idCours WHERE s.idCours = ? AND c.idUtilisateur = ?',
      [req.params.id, req.user.id],
    );
    const [result] = await dbp.query('DELETE FROM mm_cours WHERE id = ? AND idUtilisateur = ?', [req.params.id, req.user.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Cours introuvable.' });
    for (const s of supports) {
      if (s.cheminStockage) fs.unlink(s.cheminStockage, () => {}); // best effort
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// Copie les cours d'une semaine (lundi→dimanche) vers une autre, dates décalées.
// Les supports ne sont pas copiés (chaque cours redépose son PDF).
exports.duplicateWeek = (req, res, next) => {
  const { sourceLundi, cibleLundi } = req.body || {};
  if (!sourceLundi || !cibleLundi) return res.status(400).json({ error: 'Dates de semaine manquantes.' });
  const deltaJours = Math.round((new Date(cibleLundi) - new Date(sourceLundi)) / 86400000);
  const sourceDimanche = new Date(new Date(sourceLundi).getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const sql = `INSERT INTO mm_cours (idUtilisateur, idMatiere, titre, professeur, dateCours, heureDebut, heureFin, salle, niveauCharge)
               SELECT idUtilisateur, idMatiere, titre, professeur, DATE_ADD(dateCours, INTERVAL ? DAY), heureDebut, heureFin, salle, niveauCharge
                 FROM mm_cours
                WHERE idUtilisateur = ? AND dateCours BETWEEN ? AND ?`;
  db.query(sql, [deltaJours, req.user.id, sourceLundi, sourceDimanche], (err, result) => {
    if (err) return next(err);
    res.status(201).json({ inserted: result.affectedRows });
  });
};
