import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("template/neural migration", () => {
	it("replaces Markov storage and preserves reply and opt-out state", () => {
		const path = join(
			root,
			"prisma",
			"migrations",
			"20260922120000_template_neural_generation",
			"migration.sql",
		);
		expect(existsSync(path)).toBe(true);
		const sql = readFileSync(path, "utf8");
		expect(sql).toContain('DROP TABLE IF EXISTS "markov_edges"');
		expect(sql).toContain('CREATE TABLE "lexemes"');
		expect(sql).toContain('CREATE TABLE "sentence_features"');
		expect(sql).toContain('CREATE TABLE "neural_models"');
		expect(sql).toContain('DELETE FROM "learned_posts"');
		expect(sql).not.toContain('DELETE FROM "replied_posts"');
		expect(sql).not.toContain('DELETE FROM "learning_blacklist"');
	});

	it("keeps the manual learning reset and deploy-on-start path", () => {
		const reset = readFileSync(
			join(root, "scripts", "reset-markov.mjs"),
			"utf8",
		);
		for (const table of [
			"lexemes",
			"sentence_features",
			"neural_models",
			"learned_posts",
		]) {
			expect(reset).toContain(table);
		}
		expect(reset).not.toContain('DELETE FROM "replied_posts"');
		expect(readFileSync(join(root, "scripts", "start.mjs"), "utf8")).toContain(
			'"deploy"',
		);
	});
});
