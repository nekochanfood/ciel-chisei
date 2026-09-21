import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const mode = process.argv[2];
const appArgs = process.argv.slice(3);
const configArg = appArgs.find((arg) => arg.startsWith("--config="));
const configIndex = appArgs.indexOf("--config");
const configPath =
	configArg?.slice("--config=".length) ||
	(configIndex >= 0 ? appArgs[configIndex + 1] : undefined) ||
	process.env.CONFIG_PATH;
const env = configPath
	? { ...process.env, CONFIG_PATH: resolve(configPath) }
	: process.env;

const migration = spawnSync(
	process.execPath,
	[resolve("scripts/prisma.mjs"), "migrate", "deploy"],
	{ stdio: "inherit", env },
);
if (migration.status !== 0) process.exit(migration.status ?? 1);

const command =
	mode === "dev"
		? [resolve("node_modules/tsx/dist/cli.mjs"), "watch", "src/index.ts"]
		: [resolve("dist/index.js")];
const child = spawn(process.execPath, [...command, ...appArgs], {
	stdio: "inherit",
	env,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
