import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveConfigPath } from "./config.js";

function writeYaml(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ciel-chisei-"));
	const file = join(dir, "config.yaml");
	writeFileSync(file, content, "utf8");
	return file;
}

const BASE_YAML = `
ciel:
  apiBaseUrl: http://ciel.example:6137
  accessToken: yaml-token
  wsOrigin: http://ciel.example:3000
database:
  url: postgres://u:p@localhost:5432/db
bot:
  wakeWords: [ちせい]
  pollIntervalMs: 1234
  timelineBackfillPages: 2
  soloPostIntervalMinutes: 37
  replyRate: 0.5
  soloPostRate: 0.25
  replyLengthFactor: 1.5
  replyMinTokens: 3
  replyMaxTokens: 20
server:
  port: 8099
logLevel: debug
`;

describe("loadConfig (YAML only)", () => {
	it("loads every section from YAML", () => {
		const path = writeYaml(BASE_YAML);
		const config = loadConfig({ configPath: path });
		expect(config.apiBaseUrl).toBe("http://ciel.example:6137/api/v1");
		expect(config.apiOrigin).toBe("http://ciel.example:6137");
		expect(config.accessToken).toBe("yaml-token");
		expect(config.wsOrigin).toBe("http://ciel.example:3000");
		expect(config.wsUrl).toBe("ws://ciel.example:6137/ws/events");
		expect(config.databaseUrl).toBe("postgres://u:p@localhost:5432/db");
		expect(config.wakeWords).toEqual(["ちせい"]);
		expect(config.pollIntervalMs).toBe(1234);
		expect(config.timelineBackfillPages).toBe(2);
		expect(config.soloPostIntervalMinutes).toBe(37);
		expect(config.replyRate).toBe(0.5);
		expect(config.soloPostRate).toBe(0.25);
		expect(config.replyLengthFactor).toBe(1.5);
		expect(config.replyMinTokens).toBe(3);
		expect(config.replyMaxTokens).toBe(20);
		expect(config.port).toBe(8099);
		expect(config.logLevel).toBe("debug");
	});

	it("applies defaults for omitted sections", () => {
		const path = writeYaml(`
ciel:
  apiBaseUrl: http://localhost:6137
  accessToken: t
database:
  url: postgres://u:p@localhost/db
`);
		const config = loadConfig({ configPath: path });
		expect(config.wakeWords).toEqual([]);
		expect(config.pollIntervalMs).toBe(15_000);
		expect(config.timelineBackfillPages).toBe(5);
		expect(config.soloPostIntervalMinutes).toBe(120);
		expect(config.replyRate).toBe(1);
		expect(config.soloPostRate).toBe(1);
		expect(config.replyLengthFactor).toBe(1);
		expect(config.replyMinTokens).toBe(2);
		expect(config.replyMaxTokens).toBe(24);
		expect(config.wsOrigin).toBe("http://localhost:3000");
		expect(config.port).toBe(8080);
		expect(config.logLevel).toBe("info");
	});

	it("allows long-form reply lengths up to 500", () => {
		const path = writeYaml(`
ciel:
  apiBaseUrl: http://localhost:6137
  accessToken: t
database:
  url: postgres://u:p@localhost/db
bot:
  replyMaxTokens: 500
`);
		const config = loadConfig({ configPath: path });
		expect(config.replyMaxTokens).toBe(500);
	});

	it("allows disabling solo posts with 0", () => {
		const path = writeYaml(`
ciel:
  apiBaseUrl: http://localhost:6137
  accessToken: t
database:
  url: postgres://u:p@localhost/db
bot:
  soloPostIntervalMinutes: 0
`);
		const config = loadConfig({ configPath: path });
		expect(config.soloPostIntervalMinutes).toBe(0);
	});

	it("throws a friendly error when the file is missing", () => {
		expect(() =>
			loadConfig({
				configPath: join(tmpdir(), "definitely-missing-config.yaml"),
			}),
		).toThrow(/Config file not found/);
	});

	it("resolves --config from argv", () => {
		const resolved = resolveConfigPath([
			"node",
			"dist/index.js",
			"--config",
			"custom.yaml",
		]);
		expect(resolved.endsWith("custom.yaml")).toBe(true);
		const resolvedEq = resolveConfigPath(["node", "x", "--config=other.yml"]);
		expect(resolvedEq.endsWith("other.yml")).toBe(true);
	});
});
