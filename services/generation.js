// Génération des trois contenus (fiche de synthèse, cartes mémo, QCM) depuis le
// PDF d'un support, via l'API Claude. Une seule lecture du PDF : on téléverse le
// fichier une fois (Files API), puis trois générations référencent le même
// file_id avec cache_control pour lire depuis le cache (brief §7).
//
// Modèle = Haiku 4.5 (comme HomeFlow), configurable via MEMORO_GEN_MODEL. La
// sortie structurée passe par tool-use (portable), pas par output_config (spécifique
// opus-5, qui refuse minItems>1). Les n° de diapo sont des champs du schéma.
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../config/db').promise();

// Modèle configurable (défaut = Haiku 4.5, comme HomeFlow) pour le coût/latence.
const MODEL = process.env.MEMORO_GEN_MODEL || 'claude-haiku-4-5-20251001';
const FILES_BETA = 'files-api-2025-04-14';

const hasKey = () => !!process.env.ANTHROPIC_API_KEY;

const CONSIGNE_COMMUNE =
  "Travaille EXCLUSIVEMENT à partir du PDF fourni (le cours du professeur), jamais de connaissances générales du domaine. Chaque élément produit doit pouvoir être rattaché à un numéro de diapositive du PDF. Rédige en français.";

const CONSIGNE_SYNTHESE = `${CONSIGNE_COMMUNE} Produis une fiche de synthèse qui se relit en deux minutes : l'essentiel en trois points, un tableau récapitulatif si la matière s'y prête, le piège d'examen, un moyen mnémotechnique, et l'application concrète. C'est de la relecture, pas du contrôle.`;

const CONSIGNE_CARTES = `${CONSIGNE_COMMUNE} Produis des cartes mémo de rappel actif : recto = question courte qui oblige à produire la réponse, verso = réponse, et le numéro de diapositive. Vise 10 à 20 cartes selon la densité du cours.`;

const CONSIGNE_QCM = `${CONSIGNE_COMMUNE} Produis un QCM au format concours français : chaque question a exactement 5 propositions A à E, avec réponses multiples possibles ; pour chaque proposition, indique si elle est correcte, donne une explication et le numéro de diapositive. Vise une dizaine de questions couvrant l'ensemble du cours.`;

// QCM supplémentaire (bouton « Générer un nouveau QCM ») : on demande explicitement
// de varier les questions/angles par rapport au QCM standard.
const CONSIGNE_QCM_NOUVEAU = `${CONSIGNE_QCM} C'est un QCM SUPPLÉMENTAIRE : propose des questions DIFFÉRENTES, en variant les notions abordées et les diapositives couvertes, pour retester le cours sous d'autres angles.`;

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

// Sortie structurée via tool-use (portable sur tous les modèles, dont Haiku) :
// on force l'appel d'un outil dont l'input_schema est le schéma voulu, et on lit
// directement l'objet `input`. Le PDF est fourni en document (Files API) + cache.
async function generateOne(client, fileId, schema, consigne, toolName) {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 12000,
    betas: [FILES_BETA],
    tools: [{ name: toolName, description: 'Enregistre le résultat structuré demandé.', input_schema: schema }],
    tool_choice: { type: 'tool', name: toolName },
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
  const bloc = (res.content || []).find((b) => b.type === 'tool_use');
  if (!bloc || !bloc.input) throw new Error('Réponse sans tool_use structuré.');
  return { data: bloc.input, usage: res.usage || {} };
}

// Insère un QCM (mm_qcm + questions + propositions) et renvoie son id.
async function insererQcm(idCours, idSupport, questions) {
  const [qi] = await db.query('INSERT INTO mm_qcm (idCours, idSupport) VALUES (?,?)', [idCours, idSupport]);
  const idQcm = qi.insertId;
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
  return idQcm;
}

/**
 * Génère UN QCM supplémentaire sur un support existant, sans toucher aux autres
 * contenus ni archiver quoi que ce soit (bouton « Générer un nouveau QCM »).
 * Réutilise le fichier déjà téléversé ; re-téléverse une fois si le file_id a expiré.
 */
async function genererQcm(support) {
  if (!hasKey()) throw new Error('Clé Anthropic absente.');
  const client = new Anthropic();
  const { id: idSupport, idCours, cheminStockage } = support;

  const televerse = async () => {
    const up = await client.beta.files.upload({ file: fs.createReadStream(cheminStockage), betas: [FILES_BETA] });
    await db.query('UPDATE mm_support SET anthropicFileId = ? WHERE id = ?', [up.id, idSupport]);
    return up.id;
  };

  let fileId = support.anthropicFileId || (await televerse());
  let q;
  try {
    q = await generateOne(client, fileId, SCHEMA_QCM, CONSIGNE_QCM_NOUVEAU, 'enregistrer_qcm');
  } catch {
    fileId = await televerse(); // file_id expiré/invalide → nouvelle tentative
    q = await generateOne(client, fileId, SCHEMA_QCM, CONSIGNE_QCM_NOUVEAU, 'enregistrer_qcm');
  }
  return insererQcm(idCours, idSupport, q.data.questions || []);
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
    const s = await generateOne(client, uploaded.id, SCHEMA_SYNTHESE, CONSIGNE_SYNTHESE, 'enregistrer_fiche');
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
    const c = await generateOne(client, uploaded.id, SCHEMA_CARTES, CONSIGNE_CARTES, 'enregistrer_cartes');
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
    const q = await generateOne(client, uploaded.id, SCHEMA_QCM, CONSIGNE_QCM, 'enregistrer_qcm');
    await insererQcm(idCours, idSupport, q.data.questions || []);
  } catch (e) {
    console.error('Génération QCM KO:', e.message);
  }
}

module.exports = { genererContenus, genererQcm, hasKey };
