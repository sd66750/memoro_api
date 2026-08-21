-- ============================================================
-- Memoro — charge absorbable (« temps 0 ») + lissage du planning
-- ------------------------------------------------------------
-- Pourquoi : le calendrier J traite tous les cours à l'identique. En pratique,
-- plusieurs cours DENSES qui reviennent le même jour rendent la journée
-- inabsorbable → démoralisation/abandon (retour terrain). On introduit un
-- « temps 0 » (niveau de charge du cours) qui donne une DURÉE estimée à chaque
-- révision, et un BUDGET minutes/jour : le planning pose chaque révision sur le
-- jour le moins chargé de sa fenêtre (rattrapage vers l'avant), sans dépasser le
-- budget. Le « temps 0 » ne touche PAS la courbe d'oubli (les intervalles J
-- restent réglables et modulés par le QCM) : il pilote uniquement la charge.
--
-- Migration additive et non destructive (aucun DROP). Conventions : voir
-- 001_schema_initial.sql.
-- ============================================================

-- 1) Niveau de charge du cours (temps 0). 'moyen' par défaut => jamais bloquant.
ALTER TABLE mm_cours
  ADD COLUMN niveauCharge ENUM('leger','moyen','dense','tres_dense') NOT NULL DEFAULT 'moyen' AFTER professeur;

-- 2) Révisions : on garde la cible J d'origine (dueLeIdeal) pour lisser sans
--    perdre la référence, et la durée estimée (minutes) qui alimente le budget.
ALTER TABLE mm_revision
  ADD COLUMN dueLeIdeal      DATE              NULL          AFTER dueLe,
  ADD COLUMN dureeEstimeeMin SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER dueLeIdeal;

-- Backfill de l'existant : la cible J = le jour déjà posé.
UPDATE mm_revision SET dueLeIdeal = dueLe WHERE dueLeIdeal IS NULL;

-- Backfill des durées estimées des révisions non faites (hypothèse 'moyen' = 90 min,
-- fractions décroissantes par palier : .35/.25/.20/.15/.12) pour qu'elles pèsent
-- déjà dans le budget. Les nouveaux cours utiliseront le vrai niveauCharge.
UPDATE mm_revision
   SET dureeEstimeeMin = CASE indexPalier
         WHEN 0 THEN 32 WHEN 1 THEN 23 WHEN 2 THEN 18 WHEN 3 THEN 14 ELSE 11 END
 WHERE statut IN ('due','reportee') AND dureeEstimeeMin = 0;

-- 3) Budget d'absorption en minutes/jour (concrétise l'intention de
--    plafondQuotidien, laissé en place pour compatibilité).
ALTER TABLE mm_parametre
  ADD COLUMN budgetQuotidienMin SMALLINT UNSIGNED NOT NULL DEFAULT 90 AFTER plafondQuotidien;
