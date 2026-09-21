import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const configPath = resolveConfigPath();
if (!existsSync(configPath)) {
	throw new Error(
		`Config file not found: ${configPath}. Set CONFIG_PATH or create config.yaml.`,
	);
}
const config = yaml.load(readFileSync(configPath, "utf8"));
const databaseUrl = config?.database?.url;
if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
	throw new Error(`database.url is missing in ${configPath}`);
}

// ラッパー用の --config はここで消費し、Prisma CLI 本体には転送しない
// (Prisma 7 の --config は .ts モジュールを指す別物で、yaml を渡すと誤動作する)。
function stripConfigArgs(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--config") {
			i += 1;
			continue;
		}
		if (arg.startsWith("--config=")) {
			continue;
		}
		out.push(arg);
	}
	return out;
}

const child = spawn(
	process.execPath,
	[
		resolve("node_modules/prisma/build/index.js"),
		...stripConfigArgs(process.argv.slice(2)),
	],
	{
		stdio: "inherit",
		env: { ...process.env, DATABASE_URL: databaseUrl },
	},
);
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 1);
	}
});

function resolveConfigPath() {
	// `start.mjs` と同じ優先順位: --config 引数 > CONFIG_PATH > ./config.yaml。
	// ホストの CONFIG_PATH (Windows パス等) がコンテナに漏れてきた場合でも
	// --config で明示指定すればそちらが勝つ。
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
	if (fromEnv) return resolve(fromEnv);
	if (existsSync(resolve("config.yaml"))) return resolve("config.yaml");
	if (existsSync(resolve("config.yml"))) return resolve("config.yml");
	return resolve("config.yaml");
}
