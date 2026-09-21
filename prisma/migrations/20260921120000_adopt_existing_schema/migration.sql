CREATE TABLE IF NOT EXISTS "learned_posts" (
  "post_id" TEXT PRIMARY KEY,
  "author_id" TEXT NOT NULL,
  "learned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "replied_posts" (
  "post_id" TEXT PRIMARY KEY,
  "reply_id" TEXT NOT NULL,
  "replied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "markov_edges" (
  "author_id" TEXT NOT NULL DEFAULT '',
  "prefix" TEXT NOT NULL,
  "next" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "markov_edges_pkey" PRIMARY KEY ("author_id", "prefix", "next")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'markov_edges'
      AND column_name = 'author_id'
  ) THEN
    ALTER TABLE "markov_edges" ADD COLUMN "author_id" TEXT NOT NULL DEFAULT '';
    ALTER TABLE "markov_edges" DROP CONSTRAINT IF EXISTS "markov_edges_pkey";
    ALTER TABLE "markov_edges"
      ADD CONSTRAINT "markov_edges_pkey" PRIMARY KEY ("author_id", "prefix", "next");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "markov_edges_author_prefix_idx"
  ON "markov_edges" ("author_id", "prefix");
CREATE INDEX IF NOT EXISTS "markov_edges_prefix_idx"
  ON "markov_edges" ("prefix");

CREATE TABLE IF NOT EXISTS "learning_blacklist" (
  "user_id" TEXT PRIMARY KEY,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "markov_token_labels" (
  "token" TEXT PRIMARY KEY,
  "can_start" BOOLEAN NOT NULL DEFAULT false,
  "can_end" BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO "markov_token_labels" ("token", "can_start", "can_end")
SELECT "token", bool_or("can_start"), bool_or("can_end")
FROM (
  SELECT "next" AS "token", true AS "can_start", false AS "can_end"
  FROM "markov_edges"
  WHERE "prefix" = E'<BOS>\t<BOS>' AND "next" NOT IN ('<BOS>', '<EOS>')
  UNION ALL
  SELECT split_part("prefix", E'\t', 2), false, true
  FROM "markov_edges"
  WHERE "next" = '<EOS>' AND split_part("prefix", E'\t', 2) NOT IN ('<BOS>', '<EOS>')
) AS "positions"
GROUP BY "token"
ON CONFLICT ("token") DO UPDATE SET
  "can_start" = "markov_token_labels"."can_start" OR EXCLUDED."can_start",
  "can_end" = "markov_token_labels"."can_end" OR EXCLUDED."can_end";
