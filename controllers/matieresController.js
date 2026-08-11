// Matières — CRUD cloisonné par utilisateur (req.user.id).
const db = require('../config/db');

exports.getAll = (req, res, next) => {
  const sql = `SELECT m.id, m.code, m.libelle, m.couleur, m.coefficient, m.ordre,
                      (SELECT COUNT(*) FROM mm_cours c WHERE c.idMatiere = m.id) AS nbCours
                 FROM mm_matiere m
                WHERE m.idUtilisateur = ?
                ORDER BY m.ordre, m.libelle`;
  db.query(sql, [req.user.id], (err, data) => {
    if (err) return next(err);
    res.json(data);
  });
};

exports.create = (req, res, next) => {
  const { code, libelle, couleur, coefficient, ordre } = req.body || {};
  if (!libelle) return res.status(400).json({ error: 'Le libellé est obligatoire.' });
  const sql = `INSERT INTO mm_matiere (idUtilisateur, code, libelle, couleur, coefficient, ordre)
               VALUES (?,?,?,?,?,?)`;
  const params = [req.user.id, code || null, libelle, couleur || null,
    coefficient != null ? coefficient : 1, ordre != null ? ordre : 0];
  db.query(sql, params, (err, result) => {
    if (err) return next(err);
    res.status(201).json({ id: result.insertId });
  });
};

exports.update = (req, res, next) => {
  const { id } = req.params;
  const { code, libelle, couleur, coefficient, ordre } = req.body || {};
  if (!libelle) return res.status(400).json({ error: 'Le libellé est obligatoire.' });
  const sql = `UPDATE mm_matiere
                  SET code = ?, libelle = ?, couleur = ?, coefficient = ?, ordre = ?
                WHERE id = ? AND idUtilisateur = ?`;
  const params = [code || null, libelle, couleur || null,
    coefficient != null ? coefficient : 1, ordre != null ? ordre : 0, id, req.user.id];
  db.query(sql, params, (err, result) => {
    if (err) return next(err);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Matière introuvable.' });
    res.json({ ok: true });
  });
};

exports.remove = (req, res, next) => {
  const { id } = req.params;
  db.query('DELETE FROM mm_matiere WHERE id = ? AND idUtilisateur = ?', [id, req.user.id], (err, result) => {
    if (err) return next(err);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Matière introuvable.' });
    res.json({ ok: true });
  });
};
