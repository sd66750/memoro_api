// Ordonnancement des cartes mémo — SM-2 simplifié, 4 notes.
// encore (< 1 min) → revient tout de suite ; difficile / correct / facile
// espacent progressivement. La facilité (EF) est bornée à [1.3, 3.0].
function planifier(prev, note) {
  let EF = prev && prev.facilite != null ? Number(prev.facilite) : 2.5;
  let interval = prev && prev.intervalleJours != null ? Number(prev.intervalleJours) : 0;
  const q = { encore: 2, difficile: 3, correct: 4, facile: 5 }[note] ?? 4;

  let etat = 'revision';
  if (note === 'encore') {
    interval = 0; // due le jour même (session)
    etat = 'apprentissage';
  } else if (interval <= 0) {
    interval = note === 'facile' ? 4 : 1;
    etat = 'apprentissage';
  } else if (interval === 1) {
    interval = note === 'facile' ? 6 : 3;
  } else {
    const facteur = note === 'difficile' ? 1.2 : EF * (note === 'facile' ? 1.3 : 1);
    interval = Math.max(1, Math.round(interval * facteur));
  }

  EF = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  EF = Math.min(3.0, Math.max(1.3, EF));

  return { intervalleJours: interval, facilite: Math.round(EF * 100) / 100, etat };
}
module.exports = { planifier };
