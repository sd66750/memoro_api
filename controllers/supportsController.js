// Supports (PDF) : dépôt, service authentifié, remplacement, historique.
// Au dépôt : archive l'ancien support courant, archive les tentatives QCM du
// cours (ne comptent plus dans la maîtrise), génère les paliers J si c'est le
// premier support, puis lance la génération IA en tâche de fond.
const fs = require('fs');
const db = require('../config/db');
const dbp = db.promise();
const { genererRevisions } = require('../services/paliers');
const { genererContenus, hasKey } = require('../services/generation');
const { countPages } = require('../utils/pdf');

exports.upload = async (req, res, next) => {
  try {
    const idCours = Number(req.params.idCours);
    const [rows] = await dbp.query('SELECT id, dateCours FROM mm_cours WHERE id = ? AND idUtilisateur = ?', [idCours, req.user.id]);
    if (!rows.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Cours introuvable.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    if (req.file.mimetype !== 'application/pdf') {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Le support doit être un PDF.' });
    }

    const nbPages = countPages(fs.readFileSync(req.file.path));

    // Archive le support courant (on n'en supprime jamais) et les tentatives passées.
    await dbp.query('UPDATE mm_support SET estCourant = 0 WHERE idCours = ? AND estCourant = 1', [idCours]);
    await dbp.query('UPDATE mm_qcm_tentative SET surSupportArchive = 1 WHERE idCours = ?', [idCours]);

    const [ins] = await dbp.query(
      `INSERT INTO mm_support (idCours, nomFichier, mimeType, tailleOctets, nbPages, cheminStockage, estCourant)
       VALUES (?,?,?,?,?,?,1)`,
      [idCours, req.file.originalname, req.file.mimetype, req.file.size, nbPages, req.file.path]
    );
    const idSupport = ins.insertId;

    // Paliers J : uniquement au premier support (idempotent).
    await genererRevisions(req.user.id, idCours, rows[0].dateCours);

    // L'API Claude plafonne les PDF (~32 Mo). Au-delà : le dépôt, le visionnage et
    // les paliers J fonctionnent, mais on n'envoie pas en génération IA (échec
    // garanti) et on prévient le front plutôt que de laisser un échec muet.
    const MAX_IA_OCTETS = 32 * 1024 * 1024;
    const pdfTropLourdIA = req.file.size > MAX_IA_OCTETS;
    const enGeneration = hasKey() && !pdfTropLourdIA;

    res.status(201).json({ id: idSupport, nbPages, enGeneration, pdfTropLourdIA });

    // Génération IA en tâche de fond : ne bloque pas la réponse.
    if (enGeneration) {
      genererContenus({ id: idSupport, idCours, cheminStockage: req.file.path })
        .catch((e) => console.error('Génération contenus KO:', e.message));
    }
  } catch (err) {
    next(err);
  }
};

exports.serve = async (req, res, next) => {
  try {
    const [rows] = await dbp.query(
      `SELECT s.cheminStockage, s.nomFichier, s.mimeType
         FROM mm_support s JOIN mm_cours c ON c.id = s.idCours
        WHERE s.id = ? AND c.idUtilisateur = ?`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Support introuvable.' });
    const f = rows[0];
    if (!fs.existsSync(f.cheminStockage)) return res.status(404).json({ error: 'Fichier absent du stockage.' });
    res.setHeader('Content-Type', f.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.nomFichier)}"`);
    fs.createReadStream(f.cheminStockage).pipe(res);
  } catch (err) {
    next(err);
  }
};

exports.list = (req, res, next) => {
  const sql = `SELECT s.id, s.nomFichier, s.nbPages, s.tailleOctets, s.estCourant, s.anthropicFileId, s.deposeLe
                 FROM mm_support s JOIN mm_cours c ON c.id = s.idCours
                WHERE s.idCours = ? AND c.idUtilisateur = ?
                ORDER BY s.deposeLe DESC`;
  db.query(sql, [req.params.idCours, req.user.id], (err, data) => {
    if (err) return next(err);
    res.json(data);
  });
};

// Régénère les contenus sans nouveau fichier : on crée une nouvelle version du
// support pointant sur le même PDF (archive l'ancien + ses tentatives, remap des
// cartes par empreinte), puis relance la génération IA.
exports.regenerer = async (req, res, next) => {
  try {
    const idCours = Number(req.params.idCours);
    const [rows] = await dbp.query(
      `SELECT s.nomFichier, s.mimeType, s.tailleOctets, s.nbPages, s.cheminStockage
         FROM mm_support s JOIN mm_cours c ON c.id = s.idCours
        WHERE s.idCours = ? AND c.idUtilisateur = ? AND s.estCourant = 1 LIMIT 1`,
      [idCours, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aucun support courant à régénérer.' });
    if (!hasKey()) return res.status(400).json({ error: 'Génération IA indisponible (clé Anthropic absente).' });
    const cur = rows[0];
    await dbp.query('UPDATE mm_support SET estCourant = 0 WHERE idCours = ? AND estCourant = 1', [idCours]);
    await dbp.query('UPDATE mm_qcm_tentative SET surSupportArchive = 1 WHERE idCours = ?', [idCours]);
    const [ins] = await dbp.query(
      `INSERT INTO mm_support (idCours, nomFichier, mimeType, tailleOctets, nbPages, cheminStockage, estCourant)
       VALUES (?,?,?,?,?,?,1)`,
      [idCours, cur.nomFichier, cur.mimeType, cur.tailleOctets, cur.nbPages, cur.cheminStockage]
    );
    res.status(201).json({ id: ins.insertId, enGeneration: true });
    genererContenus({ id: ins.insertId, idCours, cheminStockage: cur.cheminStockage })
      .catch((e) => console.error('Régénération contenus KO:', e.message));
  } catch (err) {
    next(err);
  }
};
