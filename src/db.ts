import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;
export type DbTransaction = Prisma.TransactionClient;

export function createDb(databaseUrl: string): Db {
	const adapter = new PrismaPg({
		connectionString: databaseUrl,
		max: 8,
		idleTimeoutMillis: 20_000,
		connectionTimeoutMillis: 30_000,
	});
	return new PrismaClient({ adapter });
}

export async function addBlacklist(db: Db, userId: string): Promise<void> {
	await db.learningBlacklist.upsert({
		where: { userId },
		create: { userId },
		update: {},
	});
}

export async function removeBlacklist(db: Db, userId: string): Promise<void> {
	await db.learningBlacklist.deleteMany({ where: { userId } });
}

export async function isBlacklisted(db: Db, userId: string): Promise<boolean> {
	return (
		(await db.learningBlacklist.findUnique({ where: { userId } })) !== null
	);
}

const REQUIRED_TABLES = [
	"learned_posts",
	"replied_posts",
	"lexemes",
	"sentence_features",
	"neural_models",
	"learning_blacklist",
];

/**
 * 起動前検査: 必要テーブルがなければ migration 未適用とみなして
 * P2021 より分かりやすいエラーで落とす (原因の大半は `migrate deploy`
 * を迂回する compose command か、適用済み誤認の _prisma_migrations)。
 */
export async function assertSchemaReady(db: Db): Promise<void> {
	const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
  `;
	const present = new Set(rows.map((row) => row.tablename));
	const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
	if (missing.length > 0) {
		throw new Error(
			`[db] missing tables: ${missing.join(", ")}. Prisma migrations have not been applied. ` +
				`Run "npm run db:deploy" locally, or "docker compose up --build" for Docker ` +
				`(the bot container runs "migrate deploy" on boot via "npm start"; ` +
				`a custom compose command that bypasses "npm start" skips migrations). ` +
				`If deploy reports "no pending migrations" yet tables are missing, the migrations table is out of sync: ` +
				`mark the phantom migration as rolled back with "migrate resolve --rolled-back <name>" and redeploy.`,
		);
	}
}

export async function waitForDatabase(db: Db, attempts = 30): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i += 1) {
		try {
			await db.$connect();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	throw lastError;
}
