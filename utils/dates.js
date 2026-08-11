// Helpers de dates calendaires côté serveur (dates locales, sans fuseau).
function pad(n) { return String(n).padStart(2, '0'); }
function isoLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() { return isoLocal(new Date()); }
function isoLocalPlus(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}
function fromIso(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}
/** Positif si la date est dépassée (aujourd'hui après l'échéance). */
function daysDiff(dueIso) {
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  return Math.round((t - fromIso(dueIso)) / 86400000);
}
/** Rapproche une échéance future : aujourd'hui + moitié du délai restant. */
function halveFromToday(dueIso) {
  const restant = Math.max(0, -daysDiff(dueIso));
  return isoLocalPlus(Math.max(1, Math.ceil(restant / 2)));
}
/** Série de jours consécutifs (jusqu'à aujourd'hui/hier) présents dans la liste. */
function calcStreak(daysDesc) {
  const set = new Set(daysDesc.map((x) => String(x).slice(0, 10)));
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (!set.has(isoLocal(d))) d.setDate(d.getDate() - 1);
  let s = 0;
  while (set.has(isoLocal(d))) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
module.exports = { isoLocal, today, isoLocalPlus, fromIso, daysDiff, halveFromToday, calcStreak };
