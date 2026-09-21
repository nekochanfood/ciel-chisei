-- kuromoji 形態素トークン化への移行: 学習文ハッシュと品詞カテゴリを保存し、
-- 旧粒度 (BudouX 文節) のエッジは丸暗記の元になるため全消去して学び直す。
--
-- P3005 ベースライン運用 (既存DBに adopt を `migrate resolve --applied` した場合)
-- でも動くよう、不足テーブル・カラムの補完を含み、DELETE は存在ガード付きで行う。
-- この migration はまだどのDBにも適用されていないため編集可能。

-- 旧DBに無い場合があるテーブル・カラムの補完 (adopt 未実行ベースライン用)
CREATE TABLE IF NOT EXISTS "markov_token_labels" (
  "token" TEXT PRIMARY KEY,
  "can_start" BOOLEAN NOT NULL DEFAULT false,
  "can_end" BOOLEAN NOT NULL DEFAULT false
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

CREATE TABLE IF NOT EXISTS "markov_sequences" (
  "hash" TEXT PRIMARY KEY,
  "text" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "markov_token_pos" (
  "token" TEXT NOT NULL,
  "pos" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "markov_token_pos_pkey" PRIMARY KEY ("token", "pos", "detail")
);

-- 旧粒度データの消去 (テーブルが無いDBでも失敗しないようガード)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'markov_edges'
  ) THEN
    DELETE FROM "markov_edges";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'markov_token_labels'
  ) THEN
    DELETE FROM "markov_token_labels";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'learned_posts'
  ) THEN
    -- 学習済み印を消し、新粒度で学び直せるようにする。
    -- replied_posts (重複返信防止) と learning_blacklist は残す。
    DELETE FROM "learned_posts";
  END IF;
END $$;
