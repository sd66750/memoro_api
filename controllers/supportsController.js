// Supports (PDF) : dépôt, service authentifié, remplacement, historique.
// Au dépôt : archive l'ancien support courant, archive les tentatives QCM du
// cours (ne comptent plus dans la maîtrise), génère les paliers J si c'est le
// premier support, puis lance la génération IA en tâche de fond.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const dbp = db.promise();
const { genererRevisions } = require('../services/paliers');
const { genererContenus, hasKey } = require('../services/generation');
const { countPages } = require('../utils/pdf');
const { compressPdfInPlace } = require('../utils/pdfCompress');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');

exports.upload = async (req, res, next) => {
  // Le corps du PDF est écrit sur le disque partagé par nginx (handoff) et référencé
  // via l'en-tête X-Body-File : le gros transfert passe par nginx (rapide sur le bridge)
  // et ne touche jamais le socket de node (qui plafonne à ~8 Ko/s sur ce VPS).
  const bodyFile = req.headers['x-body-file'];
  const tmpPath = bodyFile ? path.join(STORAGE_DIR, '_up', path.basename(String(bodyFile))) : null;
  const nettoieTmp = () => { if (tmpPath) fs.unlink(tmpPath, () => {}); };
  try {
    const idCours = Number(req.params.idCours);
    const [rows] = await dbp.query('SELECT id, dateCours FROM mm_cours WHERE id = ? AND idUtilisateur = ?', [idCours, req.user.id]);
    if (!rows.length) { nettoieTmp(); return res.status(404).json({ error: 'Cours introuvable.' }); }
    if (!tmpPath || !fs.existsSync(tmpPath)) return res.status(400).json({ error: 'Aucun fichier reçu.' });

    // Vérifie que c'est un PDF par le CONTENU (octets %PDF) : Chrome/Windows envoie
    // souvent les PDF en "application/octet-stream", d'où la validation par contenu.
    const originalname = decodeURIComponent(String(req.headers['x-filename'] || 'cours.pdf'));
    let entete = '';
    try {
      const fd = fs.openSync(tmpPath, 'r');
      const buf = Buffer.alloc(5);
      fs.readSync(fd, buf, 0, 5, 0);
      fs.closeSync(fd);
      entete = buf.toString('latin1');
    } catch { /* lecture impossible → traité comme non-PDF ci-dessous */ }
    if (!entete.startsWith('%PDF') && !/\.pdf$/i.test(originalname)) {
      nettoieTmp();
      return res.status(400).json({ error: 'Le support doit être un PDF.' });
    }

    // Déplace le fichier temporaire vers un nom de stockage définitif (même volume → rename instantané).
    const finalName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`;
    const finalPath = path.join(STORAGE_DIR, finalName);
    fs.renameSync(tmpPath, finalPath);
    try { fs.chmodSync(finalPath, 0o644); } catch { /* best effort pour le service /pdf/ par nginx */ }
    const tailleOrig = fs.statSync(finalPath).size;
    const nbPages = countPages(fs.readFileSync(finalPath));

    // Archive le support courant (on n'en supprime jamais) et les tentatives passées.
    await dbp.query('UPDATE mm_support SET estCourant = 0 WHERE idCours = ? AND estCourant = 1', [idCours]);
    await dbp.query('UPDATE mm_qcm_tentative SET surSupportArchive = 1 WHERE idCours = ?', [idCours]);

    // Taille d'origine à l'INSERT ; corrigée après compression en tâche de fond.
    const [ins] = await dbp.query(
      `INSERT INTO mm_support (idCours, nomFichier, mimeType, tailleOctets, nbPages, cheminStockage, estCourant)
       VALUES (?,?,?,?,?,?,1)`,
      [idCours, originalname, 'application/pdf', tailleOrig, nbPages, finalPath]
    );
    const idSupport = ins.insertId;

    // Paliers J : uniquement au premier support (idempotent).
    await genererRevisions(req.user.id, idCours, rows[0].dateCours);

    // Réponse IMMÉDIATE : la compression Ghostscript (lente sur les gros scans) et la
    // génération IA se font EN TÂCHE DE FOND pour ne pas faire traîner/bloquer le dépôt.
    res.status(201).json({ id: idSupport, nbPages, enGeneration: hasKey() });

    // Tâche de fond : compresse (/ebook 150 dpi), met à jour la taille, puis génère
    // les contenus si le PDF est ≤ 32 Mo (plafond de l'API Claude).
    (async () => {
      try {
        const MAX_IA_OCTETS = 32 * 1024 * 1024;
        const tailleOctets = await compressPdfInPlace(finalPath, tailleOrig);
        await dbp.query('UPDATE mm_support SET tailleOctets = ? WHERE id = ?', [tailleOctets, idSupport]);
        if (hasKey() && tailleOctets <= MAX_IA_OCTETS) {
          await genererContenus({ id: idSupport, idCours, cheminStockage: finalPath });
        } else if (tailleOctets > MAX_IA_OCTETS) {
          console.warn(`[dépôt] support ${idSupport} > 32 Mo après compression → génération IA sautée`);
        }
      } catch (e) {
        console.error('Post-traitement dépôt KO:', e.message);
      }
    })();
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
    // On sert le fichier COMPLET en 200 avec un Content-Length explicite (sans lui,
    // le lecteur PDF du navigateur reste bloqué à ~80 %). On n'annonce PAS le support
    // des Range : les réponses 206/Range passent mal à travers le proxy nginx et
    // empêchaient tout affichage. Les PDF sont compressés (~8-11 Mo) → un chargement
    // complet est instantané.
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
