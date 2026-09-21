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
