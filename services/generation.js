// Génération des trois contenus (fiche de synthèse, cartes mémo, QCM) depuis le
// PDF d'un support, via l'API Claude. Une seule lecture du PDF : on téléverse le
// fichier une fois (Files API), puis trois générations référencent le même
// file_id avec cache_control pour lire depuis le cache (brief §7).
//
// Pièges respectés : modèle 'claude-opus-5' (sans suffixe) ; PAS de citations
// (incompatibles avec output_config.format) — les n° de diapo sont des champs du
// schéma ; pas de temperature/top_p (pilotage par effort) ; usage stocké.
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../config/db').promise();

const MODEL = 'claude-opus-5';
const FILES_BETA = 'files-api-2025-04-14';

const hasKey = () => !!process.env.ANTHROPIC_API_KEY;

const CONSIGNE_COMMUNE =
  "Travaille EXCLUSIVEMENT à partir du PDF fourni (le cours du professeur), jamais de connaissances générales du domaine. Chaque élément produit doit pouvoir être rattaché à un numéro de diapositive du PDF. Rédige en français.";

const CONSIGNE_SYNTHESE = `${CONSIGNE_COMMUNE} Produis une fiche de synthèse qui se relit en deux minutes : l'essentiel en trois points, un tableau récapitulatif si la matière s'y prête, le piège d'examen, un moyen mnémotechnique, et l'application concrète. C'est de la relecture, pas du contrôle.`;

const CONSIGNE_CARTES = `${CONSIGNE_COMMUNE} Produis des cartes mémo de rappel actif : recto = question courte qui oblige à produire la réponse, verso = réponse, et le numéro de diapositive. Vise 10 à 20 cartes selon la densité du cours.`;

const CONSIGNE_QCM = `${CONSIGNE_COMMUNE} Produis un QCM au format concours français : chaque question a exactement 5 propositions A à E, avec réponses multiples possibles ; pour chaque proposition, indique si elle est correcte, donne une explication et le numéro de diapositive. Vise une dizaine de questions couvrant l'ensemble du cours.`;

const SCHEMA_SYNTHESE = {
  type: 'object',
  additionalProperties: false,
  required: ['points', 'piege', 'mnemo', 'application'],
  properties: {
    points: { type: 'array', items: { type: 'string' } },
    tableau: {
      type: 'object',
      additionalProperties: false,
      required: ['titre', 'colonnes', 'lignes'],
      properties: {
        titre: { type: 'string' },
        colonnes: { type: 'array', items: { type: 'string' } },
        lignes: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      },
    },
    piege: { type: 'string' },
    mnemo: { type: 'string' },
    application: { type: 'string' },
  },
};

const SCHEMA_CARTES = {
  type: 'object',
  additionalProperties: false,
  required: ['cartes'],
  properties: {
    cartes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recto', 'verso', 'diapo'],
        properties: {
          recto: { type: 'string' },
          verso: { type: 'string' },
          diapo: { type: 'integer' },
        },
      },
    },
  },
};

const SCHEMA_QCM = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['enonce', 'propositions'],
        properties: {
          enonce: { type: 'string' },
          propositions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['lettre', 'texte', 'estCorrecte', 'explication', 'diapo'],
              properties: {
                lettre: { type: 'string' },
                texte: { type: 'string' },
                estCorrecte: { type: 'boolean' },
                explication: { type: 'string' },
                diapo: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
};

const empreinte = (recto) => crypto.createHash('sha256').update(String(recto).trim().toLowerCase()).digest('hex');

function extractJson(res) {
  if (res && res.output && typeof res.output === 'object') return res.output;
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const txt = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return JSON.parse(txt);
}

async function generateOne(client, fileId, schema, consigne) {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FILES_BETA],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: fileId }, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: consigne },
        ],
      },
    ],
  });
  return { data: extractJson(res), usage: res.usage || {} };
}

/**
 * Génère les 3 contenus pour un support fraîchement déposé. Best-effort : chaque
 * section est indépendante (un échec n'empêche pas les autres). Au remplacement
 * d'un support, les cartes d'empreinte inchangée récupèrent leur mm_carte_etat.
 */
async function genererContenus(support) {
  if (!hasKey()) {
    console.warn('ANTHROPIC_API_KEY absente : génération de contenus ignorée.');
    return;
  }
  const client = new Anthropic();
  const { id: idSupport, idCours, cheminStockage } = support;

  // 1. Téléversement unique du PDF.
  const uploaded = await client.beta.files.upload({
    file: fs.createReadStream(cheminStockage),
    betas: [FILES_BETA],
  });
  await db.query('UPDATE mm_support SET anthropicFileId = ? WHERE id = ?', [uploaded.id, idSupport]);

  // 2. Fiche de synthèse.
  try {
    const s = await generateOne(client, uploaded.id, SCHEMA_SYNTHESE, CONSIGNE_SYNTHESE);
    await db.query(
      `INSERT INTO mm_synthese (idCours, idSupport, contenuJson, modele, tokensEntree, tokensSortie)
       VALUES (?,?,?,?,?,?)`,
      [idCours, idSupport, JSON.stringify(s.data), MODEL, s.usage.input_tokens ?? null, s.usage.output_tokens ?? null]
    );
  } catch (e) {
    console.error('Génération fiche KO:', e.message);
  }

  // 3. Cartes mémo (+ report de l'état d'apprentissage par empreinte au remplacement).
  try {
    const c = await generateOne(client, uploaded.id, SCHEMA_CARTES, CONSIGNE_CARTES);
    for (const carte of c.data.cartes || []) {
      await db.query(
        `INSERT INTO mm_carte (idCours, idSupport, recto, verso, diapo, empreinteQuestion)
         VALUES (?,?,?,?,?,?)`,
        [idCours, idSupport, carte.recto, carte.verso, carte.diapo ?? null, empreinte(carte.recto)]
      );
    }
    // Remap : les cartes d'empreinte identique (ancien support) conservent leur échéance.
    await db.query(
      `UPDATE mm_carte_etat e
         JOIN mm_carte oldc ON oldc.id = e.idCarte AND oldc.idCours = ? AND oldc.idSupport <> ?
         JOIN mm_carte newc ON newc.idCours = ? AND newc.idSupport = ? AND newc.empreinteQuestion = oldc.empreinteQuestion
          SET e.idCarte = newc.id`,
      [idCours, idSupport, idCours, idSupport]
    );
  } catch (e) {
    console.error('Génération cartes KO:', e.message);
  }

  // 4. QCM.
  try {
    const q = await generateOne(client, uploaded.id, SCHEMA_QCM, CONSIGNE_QCM);
    const [qi] = await db.query('INSERT INTO mm_qcm (idCours, idSupport) VALUES (?,?)', [idCours, idSupport]);
    const idQcm = qi.insertId;
    const questions = q.data.questions || [];
    for (let i = 0; i < questions.length; i++) {
      const ques = questions[i];
      const [ri] = await db.query('INSERT INTO mm_qcm_question (idQcm, enonce, ordre) VALUES (?,?,?)', [idQcm, ques.enonce, i]);
      const idQuestion = ri.insertId;
      for (const p of ques.propositions || []) {
        await db.query(
          `INSERT INTO mm_qcm_proposition (idQuestion, lettre, texte, estCorrecte, explication, diapo)
           VALUES (?,?,?,?,?,?)`,
          [idQuestion, p.lettre, p.texte, p.estCorrecte ? 1 : 0, p.explication ?? null, p.diapo ?? null]
        );
      }
    }
  } catch (e) {
    console.error('Génération QCM KO:', e.message);
  }
}

module.exports = { genererContenus, hasKey };
