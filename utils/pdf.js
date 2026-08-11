// Comptage de pages best-effort sans dépendance : on compte les objets /Type /Page
// dans le flux PDF. Approximatif (certains PDF compressés sous-estiment), mais
// suffisant pour l'affichage. Renvoie null si indéterminé.
function countPages(buffer) {
  try {
    const s = buffer.toString('latin1');
    const m = s.match(/\/Type\s*\/Page[^s]/g);
    return m && m.length ? m.length : null;
  } catch {
    return null;
  }
}

module.exports = { countPages };
