import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function createSql(databaseUrl: string): Sql {
	return postgres(databaseUrl, {
		max: 8,
		idle_timeout: 20,
		connect_timeout: 30,
	});
}

export async function migrate(sql: Sql): Promise<void> {
	await sql`
    CREATE TABLE IF NOT EXISTS learned_posts (
      post_id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      learned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
	await sql`
    CREATE TABLE IF NOT EXISTS replied_posts (
      post_id TEXT PRIMARY KEY,
      reply_id TEXT NOT NULL,
      replied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
	await sql`
    CREATE TABLE IF NOT EXISTS markov_edges (
      author_id TEXT NOT NULL DEFAULT '',
      prefix TEXT NOT NULL,
      next TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (author_id, prefix, next)
    )
  `;
	await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'markov_edges') THEN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'markov_edges' AND column_name = 'author_id'
        ) THEN
          ALTER TABLE markov_edges ADD COLUMN author_id TEXT NOT NULL DEFAULT '';
          ALTER TABLE markov_edges DROP CONSTRAINT IF EXISTS markov_edges_pkey;
          ALTER TABLE markov_edges ADD PRIMARY KEY (author_id, prefix, next);
        END IF;
      END IF;
    END $$;
  `;
	await sql`CREATE INDEX IF NOT EXISTS markov_edges_author_prefix_idx ON markov_edges (author_id, prefix)`;
	await sql`CREATE INDEX IF NOT EXISTS markov_edges_prefix_idx ON markov_edges (prefix)`;
	await sql`
    CREATE TABLE IF NOT EXISTS learning_blacklist (
      user_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

export async function addBlacklist(sql: Sql, userId: string): Promise<void> {
	await sql`
    INSERT INTO learning_blacklist (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `;
}

export async function removeBlacklist(sql: Sql, userId: string): Promise<void> {
	await sql`
    DELETE FROM learning_blacklist
    WHERE user_id = ${userId}
  `;
}

export async function isBlacklisted(
	sql: Sql,
	userId: string,
): Promise<boolean> {
	const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM learning_blacklist
    WHERE user_id = ${userId}
  `;
	return rows.length > 0;
}

export async function waitForDatabase(sql: Sql, attempts = 30): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i += 1) {
		try {
			await sql`SELECT 1`;
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	throw lastError;
}
