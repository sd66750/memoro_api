-- ============================================================
-- Memoro — schéma initial
-- ------------------------------------------------------------
-- Pourquoi : poser l'ossature complète de la répétition espacée décrite dans le
-- brief §5. Chaque cours possède un support (PDF) ; d'un support on dérive une
-- fiche, des cartes et un QCM ; les paliers J programment les révisions ; la
-- maîtrise se mesure sur les tentatives de QCM.
--
-- Conventions (calquées sur HomeFlowAPI/migrations) : InnoDB, utf8mb4, préfixe
-- mm_, PK id AUTO_INCREMENT, colonnes camelCase, booléens estXxx TINYINT(1),
-- cloisonnement par idUtilisateur. Les FK ON DELETE CASCADE garantissent qu'une
-- suppression de compte efface réellement les données (RGPD).
-- ============================================================

-- ---------- Comptes ----------
CREATE TABLE IF NOT EXISTS mm_utilisateur (
  id             INT NOT NULL AUTO_INCREMENT,
  email          VARCHAR(190) NOT NULL,
  motDePasseHash VARCHAR(255) NOT NULL,
  nomAffiche     VARCHAR(120) DEFAULT NULL,
  actif          TINYINT(1)   NOT NULL DEFAULT 1,
  createdAt      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_utilisateur_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Refresh tokens révocables (infra auth ; opaques, stockés hachés en SHA-256).
CREATE TABLE IF NOT EXISTS mm_refresh_token (
  id             INT NOT NULL AUTO_INCREMENT,
  idUtilisateur  INT NOT NULL,
  tokenHash      CHAR(64) NOT NULL,               -- sha256(refreshToken)
  expireLe       DATETIME NOT NULL,
  estRevoque     TINYINT(1) NOT NULL DEFAULT 0,
  createdAt      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (tokenHash),
  KEY idx_refresh_user (idUtilisateur),
  CONSTRAINT fk_refresh_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Matières ----------
-- couleur = jeton de palette (ex. 'ue3'), attribué cycliquement côté app.
CREATE TABLE IF NOT EXISTS mm_matiere (
  id            INT NOT NULL AUTO_INCREMENT,
  idUtilisateur INT NOT NULL,
  code          VARCHAR(30)  DEFAULT NULL,
  libelle       VARCHAR(120) NOT NULL,
  couleur       VARCHAR(16)  DEFAULT NULL,
  coefficient   DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  ordre         INT          NOT NULL DEFAULT 0,
  createdAt     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_matiere_user (idUtilisateur),
  CONSTRAINT fk_matiere_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Cours ----------
CREATE TABLE IF NOT EXISTS mm_cours (
  id            INT NOT NULL AUTO_INCREMENT,
  idUtilisateur INT NOT NULL,
  idMatiere     INT DEFAULT NULL,
  titre         VARCHAR(200) NOT NULL,
  professeur    VARCHAR(120) DEFAULT NULL,
  dateCours     DATE         NOT NULL,
  heureDebut    TIME         DEFAULT NULL,
  heureFin      TIME         DEFAULT NULL,
  salle         VARCHAR(80)  DEFAULT NULL,
  createdAt     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cours_user (idUtilisateur),
  KEY idx_cours_matiere (idMatiere),
  KEY idx_cours_user_date (idUtilisateur, dateCours),
  CONSTRAINT fk_cours_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE,
  CONSTRAINT fk_cours_matiere FOREIGN KEY (idMatiere)
    REFERENCES mm_matiere(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Supports (PDF) ----------
-- On n'efface jamais un support : estCourant=0 historise les versions remplacées.
CREATE TABLE IF NOT EXISTS mm_support (
  id              INT NOT NULL AUTO_INCREMENT,
  idCours         INT NOT NULL,
  nomFichier      VARCHAR(255) NOT NULL,
  mimeType        VARCHAR(100) DEFAULT NULL,
  tailleOctets    BIGINT       DEFAULT NULL,
  nbPages         INT          DEFAULT NULL,
  cheminStockage  VARCHAR(500) NOT NULL,          -- chemin disque hors web-root
  anthropicFileId VARCHAR(120) DEFAULT NULL,      -- file_id Files API (cache PDF)
  estCourant      TINYINT(1)   NOT NULL DEFAULT 1,
  deposeLe        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_cours (idCours),
  KEY idx_support_courant (idCours, estCourant),
  CONSTRAINT fk_support_cours FOREIGN KEY (idCours)
    REFERENCES mm_cours(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Fiche de synthèse ----------
CREATE TABLE IF NOT EXISTS mm_synthese (
  id           INT NOT NULL AUTO_INCREMENT,
  idCours      INT NOT NULL,
  idSupport    INT NOT NULL,
  contenuJson  JSON NOT NULL,
  modele       VARCHAR(60)  DEFAULT NULL,
  tokensEntree INT          DEFAULT NULL,
  tokensSortie INT          DEFAULT NULL,
  genereLe     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_synthese_cours (idCours),
  KEY idx_synthese_support (idSupport),
  CONSTRAINT fk_synthese_cours FOREIGN KEY (idCours)
    REFERENCES mm_cours(id) ON DELETE CASCADE,
  CONSTRAINT fk_synthese_support FOREIGN KEY (idSupport)
    REFERENCES mm_support(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Cartes mémo ----------
-- empreinteQuestion = hash du recto : conserve l'état d'apprentissage au
-- remplacement du support si la question est inchangée.
CREATE TABLE IF NOT EXISTS mm_carte (
  id                INT NOT NULL AUTO_INCREMENT,
  idCours           INT NOT NULL,
  idSupport         INT NOT NULL,
  recto             TEXT NOT NULL,
  verso             TEXT NOT NULL,
  diapo             INT  DEFAULT NULL,
  empreinteQuestion CHAR(64) DEFAULT NULL,
  createdAt         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_carte_cours (idCours),
  KEY idx_carte_support (idSupport),
  KEY idx_carte_empreinte (idCours, empreinteQuestion),
  CONSTRAINT fk_carte_cours FOREIGN KEY (idCours)
    REFERENCES mm_cours(id) ON DELETE CASCADE,
  CONSTRAINT fk_carte_support FOREIGN KEY (idSupport)
    REFERENCES mm_support(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- État SM-2 par carte et par utilisateur (rythme propre, indépendant des paliers J).
-- etat ∈ 'nouveau'|'apprentissage'|'revision'|'suspendu' ; facilite = EF SM-2 ;
-- derniereNote ∈ 'encore'|'difficile'|'correct'|'facile'.
CREATE TABLE IF NOT EXISTS mm_carte_etat (
  id              INT NOT NULL AUTO_INCREMENT,
  idUtilisateur   INT NOT NULL,
  idCarte         INT NOT NULL,
  etat            VARCHAR(20)  NOT NULL DEFAULT 'nouveau',
  intervalleJours INT          NOT NULL DEFAULT 0,
  facilite        DECIMAL(4,2) NOT NULL DEFAULT 2.50,
  dueLe           DATE         DEFAULT NULL,
  derniereNote    VARCHAR(12)  DEFAULT NULL,
  revueLe         DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_carte_etat (idUtilisateur, idCarte),
  KEY idx_carte_etat_due (idUtilisateur, dueLe),
  CONSTRAINT fk_carte_etat_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE,
  CONSTRAINT fk_carte_etat_carte FOREIGN KEY (idCarte)
    REFERENCES mm_carte(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- QCM ----------
CREATE TABLE IF NOT EXISTS mm_qcm (
  id        INT NOT NULL AUTO_INCREMENT,
  idCours   INT NOT NULL,
  idSupport INT NOT NULL,
  genereLe  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_qcm_cours (idCours),
  KEY idx_qcm_support (idSupport),
  CONSTRAINT fk_qcm_cours FOREIGN KEY (idCours)
    REFERENCES mm_cours(id) ON DELETE CASCADE,
  CONSTRAINT fk_qcm_support FOREIGN KEY (idSupport)
    REFERENCES mm_support(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mm_qcm_question (
  id      INT NOT NULL AUTO_INCREMENT,
  idQcm   INT NOT NULL,
  enonce  TEXT NOT NULL,
  ordre   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_question_qcm (idQcm),
  CONSTRAINT fk_question_qcm FOREIGN KEY (idQcm)
    REFERENCES mm_qcm(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Format concours : 5 propositions A–E, réponses multiples, explication + diapo.
CREATE TABLE IF NOT EXISTS mm_qcm_proposition (
  id          INT NOT NULL AUTO_INCREMENT,
  idQuestion  INT NOT NULL,
  lettre      CHAR(1) NOT NULL,
  texte       TEXT NOT NULL,
  estCorrecte TINYINT(1) NOT NULL DEFAULT 0,
  explication TEXT DEFAULT NULL,
  diapo       INT  DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_proposition_question (idQuestion),
  CONSTRAINT fk_proposition_question FOREIGN KEY (idQuestion)
    REFERENCES mm_qcm_question(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tentative : palier = indexPalier lié (NULL si révision libre). surSupportArchive=1
-- => tentative sur support remplacé : visible mais exclue du calcul de maîtrise.
CREATE TABLE IF NOT EXISTS mm_qcm_tentative (
  id                INT NOT NULL AUTO_INCREMENT,
  idUtilisateur     INT NOT NULL,
  idQcm             INT NOT NULL,
  idCours           INT NOT NULL,
  palier            INT DEFAULT NULL,
  debutLe           DATETIME DEFAULT NULL,
  finLe             DATETIME DEFAULT NULL,
  scoreObtenu       INT DEFAULT NULL,
  scoreTotal        INT DEFAULT NULL,
  pourcentage       DECIMAL(5,2) DEFAULT NULL,
  surSupportArchive TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_tentative_user (idUtilisateur),
  KEY idx_tentative_qcm (idQcm),
  KEY idx_tentative_cours (idCours),
  KEY idx_tentative_maitrise (idCours, surSupportArchive),
  CONSTRAINT fk_tentative_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE,
  CONSTRAINT fk_tentative_qcm FOREIGN KEY (idQcm)
    REFERENCES mm_qcm(id) ON DELETE CASCADE,
  CONSTRAINT fk_tentative_cours FOREIGN KEY (idCours)
    REFERENCES mm_cours(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mm_qcm_reponse (
  id             INT NOT NULL AUTO_INCREMENT,
  idTentative    INT NOT NULL,
  idQuestion     INT NOT NULL,
  lettresCochees VARCHAR(10) DEFAULT NULL,        -- ex. 'ACE'
  estCorrecte    TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_reponse_tentative (idTentative),
  KEY idx_reponse_question (idQuestion),
  CONSTRAINT fk_reponse_tentative FOREIGN KEY (idTentative)
    REFERENCES mm_qcm_tentative(id) ON DELETE CASCADE,
  CONSTRAINT fk_reponse_question FOREIGN KEY (idQuestion)
    REFERENCES mm_qcm_question(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Paliers J / révisions programmées ----------
-- statut ∈ 'due'|'faite'|'reportee' ; reportDepuis = date d'origine d'un report.
CREATE TABLE IF NOT EXISTS mm_revision (
  id            INT NOT NULL AUTO_INCREMENT,
  idUtilisateur INT NOT NULL,
  idCours       INT NOT NULL,
  indexPalier   INT NOT NULL,
  dueLe         DATE NOT NULL,
  statut        VARCHAR(12) NOT NULL DEFAULT 'due',
  faitLe        DATETIME DEFAULT NULL,
  reportDepuis  DATE DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_revision_cours (idCours),
  KEY idx_revision_agenda (idUtilisateur, dueLe, statut),
  CONSTRAINT fk_revision_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE,
  CONSTRAINT fk_revision_cours FOREIGN KEY (idCours)
    REFERENCES mm_cours(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Paramètres par utilisateur ----------
-- PK = idUtilisateur (une ligne par compte). paliersJson défaut posé à l'inscription.
CREATE TABLE IF NOT EXISTS mm_parametre (
  idUtilisateur    INT NOT NULL,
  paliersJson      JSON NOT NULL,
  modeExigeant     TINYINT(1) NOT NULL DEFAULT 0,
  seuilQcm         INT NOT NULL DEFAULT 70,
  plafondQuotidien INT DEFAULT NULL,
  updatedAt        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (idUtilisateur),
  CONSTRAINT fk_parametre_user FOREIGN KEY (idUtilisateur)
    REFERENCES mm_utilisateur(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
