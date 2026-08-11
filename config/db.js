// Pool MySQL partagé (mysql2). Calqué sur HomeFlowAPI/config/db.js.
// On expose le pool callback ; `db.promise()` reste disponible pour les flux
// séquentiels (auth) où l'async/await est plus lisible.
const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: process.env.DB_PORT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // Dates renvoyées en chaînes ('YYYY-MM-DD', 'HH:MM:SS') : on manipule des dates
  // calendaires (cours, échéances), sans piège de fuseau horaire.
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

pool.on('error', (err) => {
  console.error('Erreur dans le pool de connexions:', err);
});

module.exports = pool;
