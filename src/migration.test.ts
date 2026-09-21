import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(...parts: string[]): string {
	return readFileSync(join(root, ...parts), "utf8");
}

// kuromoji 移行時の学習データ消去が、ローカル・Docker どちらのデプロイでも
// 確実に走るための回帰テスト。消去ロジックを変える場合はこのテストも更新すること。
describe("markov wipe on deploy", () => {
	it("ships a migration that wipes old-granularity learning data", () => {
		const migrationsDir = join(root, "prisma", "migrations");
		const entries = readdirSync(migrationsDir).filter((entry) =>
			entry.includes("markov_sequences"),
		);
		expect(entries.length).toBeGreaterThan(0);
		const sql = readRepoFile(
			"prisma",
			"migrations",
			entries[0] as string,
			"migration.sql",
		);
		// 旧粒度 (BudouX 文節) の丸暗記の元を全消去する
		expect(sql).toContain('DELETE FROM "markov_edges"');
		expect(sql).toContain('DELETE FROM "markov_token_labels"');
		// 学習済み印も消して新粒度で学び直す (重複返信防止の replied_posts は残す)
		expect(sql).toContain('DELETE FROM "learned_posts"');
		expect(sql).not.toContain('DELETE FROM "replied_posts"');
		expect(sql).not.toContain('DELETE FROM "learning_blacklist"');
		// 新テーブルを作成する
		expect(sql).toContain('"markov_sequences"');
		expect(sql).toContain('"markov_token_pos"');
		// P3005 ベースライン (adopt 未実行) でも失敗しないよう不足分を補完する
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS "markov_token_labels"');
	});

	it("runs migrate deploy on every boot, including Docker", () => {
		// scripts/start.mjs は bot 起動前に必ず `migrate deploy` する。
		// compose の bot command は `npm start` なので Docker でも同じ経路を通る。
		const start = readRepoFile("scripts", "start.mjs");
		expect(start).toContain('"migrate"');
		expect(start).toContain('"deploy"');
		const compose = readRepoFile("docker-compose.yml.example");
		expect(compose).toContain('"npm", "start"');
	});

	it("ships prisma migrations inside the Docker image", () => {
		const dockerfile = readRepoFile("Dockerfile");
		expect(dockerfile).toContain("COPY prisma ./prisma");
		expect(dockerfile).toContain("COPY --from=build /app/prisma ./prisma");
	});

	it("keeps a manual wipe script for leftovers", () => {
		expect(existsSync(join(root, "scripts", "reset-markov.mjs"))).toBe(true);
		const script = readRepoFile("scripts", "reset-markov.mjs");
		for (const table of [
			"markov_edges",
			"markov_token_labels",
			"markov_sequences",
			"markov_token_pos",
			"markov_token_forms",
			"markov_patterns",
			"learned_posts",
		]) {
			expect(script).toContain(table);
		}
		expect(script).not.toContain('DELETE FROM "replied_posts"');
		expect(script).not.toContain('DELETE FROM "learning_blacklist"');
	});

	it("ships a migration that adds sentence-pattern tables", () => {
		const dir = join(
			root,
			"prisma",
			"migrations",
			"20260921140000_sentence_patterns",
			"migration.sql",
		);
		expect(existsSync(dir)).toBe(true);
		const sql = readFileSync(dir, "utf8");
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS "markov_token_forms"');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS "markov_patterns"');
		// 追加のみ: 既存の学習データは消さない
		expect(sql).not.toContain("DELETE FROM");
	});
});
