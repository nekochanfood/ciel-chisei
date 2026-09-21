import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

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

const child = spawn(
	process.execPath,
	[resolve("node_modules/prisma/build/index.js"), ...process.argv.slice(2)],
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
	const fromEnv = process.env.CONFIG_PATH;
	if (fromEnv) return resolve(fromEnv);
	if (existsSync(resolve("config.yaml"))) return resolve("config.yaml");
	if (existsSync(resolve("config.yml"))) return resolve("config.yml");
	return resolve("config.yaml");
}
