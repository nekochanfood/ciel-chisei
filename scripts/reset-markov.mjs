import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import pg from "pg";

// 学習済み語彙・特徴・モデルを消し、タイムラインから学び直す手動スクリプト。

// learned_posts (学習済み印) も消すことで、再起動後の遡及・独り言履歴で
// 学び直しが進む。replied_posts (重複返信防止) と learning_blacklist
// (オプトアウト) は残す。
const TABLES = [
	"lexemes",
	"sentence_features",
	"neural_models",
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
			`[reset-learning] ${table}: deleted ${result.rowCount ?? 0} rows`,
		);
	}
} finally {
	await client.end();
}
console.info("[reset-learning] done. Restart the bot to relearn from scratch.");
