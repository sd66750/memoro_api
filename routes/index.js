// Agrégateur des routes (calqué sur HomeFlowAPI/routes/index.js).
// server.js monte chaque routeur sous /api (ou /api/<domaine>).
const auth = require('./auth');
const matieres = require('./matieres');
const cours = require('./cours');
const supports = require('./supports');
const qcm = require('./qcm');
const cartes = require('./cartes');
const progression = require('./progression');

module.exports = {
  auth,
  matieres,
  cours,
  supports,
  qcm,
  cartes,
  progression,
};
