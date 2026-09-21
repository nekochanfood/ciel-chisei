-- 文型スケルトンと動詞活用情報の保存: 文の「形」を覚え、
-- スロット充足生成 (文型を選んで品詞・活用型の合う語彙をはめる) に使う。
--
-- 追加のみの migration (既存データは消さない)。文型・活用情報は
-- wipe 後の学び直しで蓄積される (`npm run db:reset-markov`)。
-- P3005 ベースライン運用でも動くよう IF NOT EXISTS でガードする。

CREATE TABLE IF NOT EXISTS "markov_token_forms" (
  "token" TEXT NOT NULL,
  "pos" TEXT NOT NULL DEFAULT '',
  "basic_form" TEXT NOT NULL DEFAULT '',
  "conjugation" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "markov_token_forms_pkey" PRIMARY KEY ("token", "pos", "basic_form", "conjugation")
);

CREATE TABLE IF NOT EXISTS "markov_patterns" (
  "pattern" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "markov_patterns_pkey" PRIMARY KEY ("pattern")
);
