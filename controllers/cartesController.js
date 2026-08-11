// Cartes mémo : notation (SM-2, upsert de l'état par utilisateur) et export CSV
// (importable dans Anki).
const db = require('../config/db').promise();
const { planifier } = require('../utils/sm2');
const { isoLocalPlus } = require('../utils/dates');

const NOTES = ['encore', 'difficile', 'correct', 'facile'];

exports.noter = async (req, res, next) => {
  try {
    const idCarte = Number(req.params.id);
    const { note } = req.body || {};
    if (!NOTES.includes(note)) return res.status(400).json({ error: 'Note invalide.' });
    const uid = req.user.id;

    const [own] = await db.query(
      'SELECT ca.id FROM mm_carte ca JOIN mm_cours c ON c.id = ca.idCours AND c.idUtilisateur = ? WHERE ca.id = ?',
      [uid, idCarte]
    );
    if (!own.length) return res.status(404).json({ error: 'Carte introuvable.' });

    const [existing] = await db.query('SELECT intervalleJours, facilite, etat FROM mm_carte_etat WHERE idUtilisateur = ? AND idCarte = ?', [uid, idCarte]);
    const plan = planifier(existing[0] || null, note);
    const dueLe = isoLocalPlus(plan.intervalleJours);

    if (existing.length) {
      await db.query(
        'UPDATE mm_carte_etat SET etat = ?, intervalleJours = ?, facilite = ?, dueLe = ?, derniereNote = ?, revueLe = NOW() WHERE idUtilisateur = ? AND idCarte = ?',
        [plan.etat, plan.intervalleJours, plan.facilite, dueLe, note, uid, idCarte]
      );
    } else {
      await db.query(
        'INSERT INTO mm_carte_etat (idUtilisateur, idCarte, etat, intervalleJours, facilite, dueLe, derniereNote, revueLe) VALUES (?,?,?,?,?,?,?,NOW())',
        [uid, idCarte, plan.etat, plan.intervalleJours, plan.facilite, dueLe, note]
      );
    }
    res.json({ ok: true, dueLe, intervalleJours: plan.intervalleJours, facilite: plan.facilite, etat: plan.etat });
  } catch (err) {
    next(err);
  }
};

exports.exportCsv = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.query(
      `SELECT ca.recto, ca.verso, ca.diapo
         FROM mm_carte ca
         JOIN mm_support s ON s.id = ca.idSupport AND s.estCourant = 1
         JOIN mm_cours c ON c.id = ca.idCours AND c.idUtilisateur = ?
        WHERE ca.idCours = ? ORDER BY ca.id`,
      [req.user.id, id]
    );
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = rows.map((r) => [esc(r.recto), esc(r.verso), esc(r.diapo != null ? `diapo ${r.diapo}` : '')].join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cartes-cours-${id}.csv"`);
    res.send('﻿' + csv); // BOM pour Excel/Anki
  } catch (err) {
    next(err);
  }
};
