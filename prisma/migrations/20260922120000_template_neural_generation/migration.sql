-- Replace unstable Markov/pattern generation with curated templates and a
-- small persisted neural candidate ranker. Replies and opt-out state survive.
DROP TABLE IF EXISTS "markov_patterns";
DROP TABLE IF EXISTS "markov_token_forms";
DROP TABLE IF EXISTS "markov_token_pos";
DROP TABLE IF EXISTS "markov_sequences";
DROP TABLE IF EXISTS "markov_token_labels";
DROP TABLE IF EXISTS "markov_edges";

CREATE TABLE "lexemes" (
  "surface" TEXT NOT NULL,
  "pos" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "basic_form" TEXT NOT NULL DEFAULT '',
  "conjugation" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "lexemes_pkey" PRIMARY KEY ("surface", "pos", "detail", "basic_form", "conjugation")
);
CREATE INDEX "lexemes_pos_idx" ON "lexemes"("pos");

CREATE TABLE "sentence_features" (
  "post_id" TEXT NOT NULL,
  "sentence_index" INTEGER NOT NULL,
  "author_id" TEXT NOT NULL,
  "features" JSONB NOT NULL,
  CONSTRAINT "sentence_features_pkey" PRIMARY KEY ("post_id", "sentence_index")
);

CREATE TABLE "neural_models" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "example_count" INTEGER NOT NULL DEFAULT 0,
  "state" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "neural_models_pkey" PRIMARY KEY ("id")
);

DELETE FROM "learned_posts";
