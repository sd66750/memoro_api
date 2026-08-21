// Barème « temps 0 » (charge d'un cours) → minutes, durée estimée d'une révision,
// et dérive de placement autorisée par palier. Le temps 0 pilote UNIQUEMENT la
// charge (durée + lissage), jamais la courbe d'oubli (les intervalles J restent
// la répétition espacée, réglables + modulés par le QCM). Valeurs calibrables.

// Niveau de charge (saisi via une échelle rapide) → minutes du « temps 0 ».
const T0_MINUTES = { leger: 45, moyen: 90, dense: 150, tres_dense: 240 };

// Relire coûte moins que d'apprendre : fraction du temps 0 par index de palier,
// décroissante (la 1re relecture est la plus longue).
const FRACTION_PALIER = [0.35, 0.25, 0.2, 0.15, 0.12];

// Garde-fou du rattrapage : glissement maximal (jours) autorisé par index de
// palier. Au-delà, on n'étale plus en silence → le jour passe en surbudget
// visible et l'alerte de surcharge structurelle se déclenche.
const DERIVE_MAX = [2, 2, 3, 5, 7];

// Budget d'absorption par défaut (minutes/jour), utilisé si non renseigné.
const BUDGET_DEFAUT = 90;

function t0Minutes(niveau) {
  return T0_MINUTES[niveau] ?? T0_MINUTES.moyen;
}
function fractionPalier(i) {
  return FRACTION_PALIER[i] ?? FRACTION_PALIER[FRACTION_PALIER.length - 1];
}
/** Durée estimée (minutes) d'une révision, selon le niveau du cours et le palier. */
function dureeRevision(niveau, i) {
  return Math.max(1, Math.round(t0Minutes(niveau) * fractionPalier(i)));
}
function deriveMax(i) {
  return DERIVE_MAX[i] ?? DERIVE_MAX[DERIVE_MAX.length - 1];
}

module.exports = {
  T0_MINUTES,
  FRACTION_PALIER,
  DERIVE_MAX,
  BUDGET_DEFAUT,
  t0Minutes,
  fractionPalier,
  dureeRevision,
  deriveMax,
};
