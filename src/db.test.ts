import { describe, expect, it, vi } from "vitest";
import { assertSchemaReady, type Db } from "./db.js";

const ALL_TABLES = [
	"learned_posts",
	"replied_posts",
	"markov_edges",
	"markov_token_labels",
	"markov_sequences",
	"markov_token_pos",
	"markov_token_forms",
	"markov_patterns",
	"learning_blacklist",
];

function mockDb(tables: string[]): Db {
	return {
		$queryRaw: vi
			.fn()
			.mockResolvedValue(tables.map((tablename) => ({ tablename }))),
	} as unknown as Db;
}

describe("assertSchemaReady", () => {
	it("resolves when every required table exists", async () => {
		await expect(
			assertSchemaReady(mockDb(ALL_TABLES)),
		).resolves.toBeUndefined();
	});

	it("ignores extra tables", async () => {
		await expect(
			assertSchemaReady(mockDb([...ALL_TABLES, "_prisma_migrations", "other"])),
		).resolves.toBeUndefined();
	});

	it("throws a boot-actionable error listing the missing tables", async () => {
		const error = await assertSchemaReady(mockDb([])).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("markov_token_labels");
		expect(message).toContain("markov_sequences");
		expect(message).toContain("markov_token_pos");
		expect(message).toContain("migrate deploy");
		expect(message).toContain("npm start");
	});
});
