import { ChiseiBot } from "./bot/chisei.js";
import { MarkovModel } from "./bot/markov.js";
import { loadTokenizer } from "./bot/tokenizer.js";
import { createCielClient } from "./ciel/client.js";
import { connectRealtime } from "./ciel/websocket.js";
import { loadConfig } from "./config.js";
import { createSql, migrate, waitForDatabase } from "./db.js";
import { startHealthServer } from "./health.js";

async function main(): Promise<void> {
	const config = loadConfig();
	const sql = createSql(config.databaseUrl);
	let ready = false;
	const health = startHealthServer(config.port, () => ready);

	await waitForDatabase(sql);
	await migrate(sql);
	await loadTokenizer();

	const markov = new MarkovModel();
	await markov.load(sql);

	const client = createCielClient(config);
	const me = await client.me();
	console.info(
		`[bot] logged in as @${me.username} (${me.id}), markov edges=${markov.edgeCount}`,
	);

	const bot = new ChiseiBot(sql, client, me, markov, config.wakeWords);

	const seen = new Set<string>();
	const handle = async (
		post: { id: string } & Parameters<ChiseiBot["handlePost"]>[0],
	) => {
		if (seen.has(post.id)) {
			return;
		}
		seen.add(post.id);
		if (seen.size > 5000) {
			seen.clear();
		}
		await bot.handlePost(post);
	};

	await backfill(client, bot, config.timelineBackfillPages);
	await bot.syncBio();

	const stopWs = connectRealtime(config, {
		onPost: (post) => handle(post),
		onError: (error) => console.warn("[ws]", error),
	});

	const bioSyncTimer = setInterval(() => {
		void bot.syncBio();
	}, 5 * 60_000); // Sync bio every 5 minutes if word count changed

	const pollTimer = setInterval(() => {
		void pollTimeline(client, handle);
	}, config.pollIntervalMs);

	let soloTimer: NodeJS.Timeout | undefined;
	if (config.soloPostIntervalMinutes > 0) {
		const soloIntervalMs = config.soloPostIntervalMinutes * 60_000;
		console.info(
			`[bot] solo posts every ${config.soloPostIntervalMinutes} min`,
		);
		soloTimer = setInterval(() => {
			void bot.postSolo();
		}, soloIntervalMs);
	} else {
		console.info("[bot] solo posts disabled (soloPostIntervalMinutes=0)");
	}

	const shutdown = async () => {
		clearInterval(pollTimer);
		clearInterval(bioSyncTimer);
		if (soloTimer) {
			clearInterval(soloTimer);
		}
		stopWs();
		health.close();
		await sql.end({ timeout: 5 });
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	ready = true;
}

async function backfill(
	client: ReturnType<typeof createCielClient>,
	bot: ChiseiBot,
	pages: number,
): Promise<void> {
	let cursor: string | null | undefined;
	for (let i = 0; i < pages; i += 1) {
		const page = await client.timeline({ limit: 30, cursor });
		for (const post of [...page.items].reverse()) {
			await bot.handlePost(post);
		}
		if (!page.nextCursor) {
			break;
		}
		cursor = page.nextCursor;
	}
}

async function pollTimeline(
	client: ReturnType<typeof createCielClient>,
	handle: (post: Parameters<ChiseiBot["handlePost"]>[0]) => Promise<void>,
): Promise<void> {
	try {
		const page = await client.timeline({ limit: 30 });
		for (const post of [...page.items].reverse()) {
			await handle(post);
		}
	} catch (error) {
		console.warn("[poll] timeline failed", error);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
