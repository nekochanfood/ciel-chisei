import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";

// .env は使わない。設定は YAML のみが正本。
const yamlSchema = z.object({
	ciel: z.object({
		apiBaseUrl: z.string().min(1),
		accessToken: z.string().min(1),
		wsOrigin: z.string().min(1).default("http://localhost:3000"),
		wsUrl: z.string().optional(),
	}),
	database: z.object({
		url: z.string().min(1),
	}),
	bot: z
		.object({
			wakeWords: z.array(z.string()).default([]),
			pollIntervalMs: z.number().int().positive().default(15_000),
			timelineBackfillPages: z.number().int().min(0).max(50).default(5),
			soloPostIntervalMinutes: z.number().int().min(0).default(120),
		})
		.default({}),
	server: z
		.object({
			port: z.number().int().positive().default(8080),
		})
		.default({}),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type YamlConfig = z.infer<typeof yamlSchema>;

export type Config = {
	apiOrigin: string;
	apiBaseUrl: string;
	accessToken: string;
	wsOrigin: string;
	wsUrl: string;
	databaseUrl: string;
	wakeWords: string[];
	pollIntervalMs: number;
	timelineBackfillPages: number;
	soloPostIntervalMinutes: number;
	port: number;
	logLevel: "debug" | "info" | "warn" | "error";
};

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function configPathFromArgs(
	argv: readonly string[] = process.argv,
): string | undefined {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--config" && i + 1 < argv.length) {
			return argv[i + 1];
		}
		const match = arg?.match(/^--config=(.+)$/);
		if (match?.[1]) {
			return match[1];
		}
	}
	return undefined;
}

export function resolveConfigPath(
	argv: readonly string[] = process.argv,
): string {
	const fromArgs = configPathFromArgs(argv);
	if (fromArgs && fromArgs.trim().length > 0) {
		return resolve(fromArgs);
	}
	const fromEnv = process.env.CONFIG_PATH;
	if (fromEnv && fromEnv.trim().length > 0) {
		return resolve(fromEnv);
	}
	const yamlPath = resolve(process.cwd(), "config.yaml");
	if (existsSync(yamlPath)) {
		return yamlPath;
	}
	const ymlPath = resolve(process.cwd(), "config.yml");
	if (existsSync(ymlPath)) {
		return ymlPath;
	}
	return yamlPath;
}

export function loadYamlFile(configPath: string): YamlConfig {
	if (!existsSync(configPath)) {
		throw new Error(
			`Config file not found: ${configPath}. Copy config.yaml.example to config.yaml and edit it.`,
		);
	}
	const raw = readFileSync(configPath, "utf8");
	if (raw.trim().length === 0) {
		throw new Error(`Config file is empty: ${configPath}.`);
	}
	const parsed: unknown = yaml.load(raw);
	return yamlSchema.parse(parsed);
}

export function loadConfig(
	options: { configPath?: string; argv?: readonly string[] } = {},
): Config {
	const configPath = options.configPath ?? resolveConfigPath(options.argv);
	const file = loadYamlFile(configPath);
	console.info(`[config] loaded ${configPath}`);

	const apiOrigin = stripTrailingSlash(
		file.ciel.apiBaseUrl.replace(/\/api\/v1$/i, ""),
	);
	const apiBaseUrl = `${apiOrigin}/api/v1`;
	const wsUrl =
		file.ciel.wsUrl ?? `${apiOrigin.replace(/^http/i, "ws")}/ws/events`;

	return {
		apiOrigin,
		apiBaseUrl,
		accessToken: file.ciel.accessToken,
		wsOrigin: file.ciel.wsOrigin,
		wsUrl,
		databaseUrl: file.database.url,
		wakeWords: file.bot.wakeWords,
		pollIntervalMs: file.bot.pollIntervalMs,
		timelineBackfillPages: file.bot.timelineBackfillPages,
		soloPostIntervalMinutes: file.bot.soloPostIntervalMinutes,
		port: file.server.port,
		logLevel: file.logLevel,
	};
}
