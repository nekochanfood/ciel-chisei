import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import pg from "pg";

// 学習データ (旧粒度の丸暗記の元) を全消去して学び直すための手動スクリプト。
// 通常は Prisma migration (20260921130000_markov_sequences) が初回デプロイ時に
// 自動で消去する (`npm start` / Docker 起動時の `migrate deploy` 経由)。
// 取りこぼし時や再トークン化時に手動で使う:
//   npm run db:reset-markov -- --config ./config.yaml
//   docker compose exec bot npm run db:reset-markov -- --config /app/config.yaml

// learned_posts (学習済み印) も消すことで、再起動後の遡及・独り言履歴で
// 学び直しが進む。replied_posts (重複返信防止) と learning_blacklist
// (オプトアウト) は残す。
const TABLES = [
	"markov_edges",
	"markov_token_labels",
	"markov_sequences",
	"markov_token_pos",
	"learned_posts",
];

function resolveConfigPath() {
	const argv = process.argv.slice(2);
	const flag = argv.indexOf("--config");
	if (flag >= 0 && argv[flag + 1]) {
		return resolve(argv[flag + 1]);
	}
	const eq = argv.find((arg) => arg.startsWith("--config="));
	if (eq) {
		return resolve(eq.slice("--config=".length));
	}
	const fromEnv = process.env.CONFIG_PATH;
	if (fromEnv) {
		return resolve(fromEnv);
	}
	if (existsSync(resolve("config.yaml"))) {
		return resolve("config.yaml");
	}
	if (existsSync(resolve("config.yml"))) {
		return resolve("config.yml");
	}
	return resolve("config.yaml");
}

const configPath = resolveConfigPath();
if (!existsSync(configPath)) {
	throw new Error(
		`Config file not found: ${configPath}. Set --config or CONFIG_PATH.`,
	);
}
const config = yaml.load(readFileSync(configPath, "utf8"));
const databaseUrl = config?.database?.url;
if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
	throw new Error(`database.url is missing in ${configPath}`);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
	for (const table of TABLES) {
		const result = await client.query(`DELETE FROM "${table}"`);
		console.info(
			`[reset-markov] ${table}: deleted ${result.rowCount ?? 0} rows`,
		);
	}
} finally {
	await client.end();
}
console.info("[reset-markov] done. Restart the bot to relearn from scratch.");
