import { describe, expect, it, vi } from "vitest";
import { ChiseiBot } from "./bot/chisei.js";
import { MarkovModel } from "./bot/markov.js";
import type { CielClient, Post, User } from "./ciel/client.js";
import type { Sql } from "./db.js";

describe("ChiseiBot", () => {
	const me: User = {
		id: "bot_123",
		username: "chisei",
		displayName: "知性bot",
		createdAt: new Date().toISOString(),
	};

	function createMockSetup() {
		const executedSql: string[] = [];
		const blacklist = new Set<string>();

		// Mock sql tagged template
		const sql = (async (
			strings: TemplateStringsArray,
			...values: unknown[]
		) => {
			const query = strings.join("?");
			executedSql.push(query);

			const q = query.toLowerCase().replace(/\s+/g, " ");
			if (q.includes("delete from learning_blacklist")) {
				const userId = values[0] as string;
				blacklist.delete(userId);
				return [];
			}
			if (q.includes("insert into learning_blacklist")) {
				const userId = values[0] as string;
				blacklist.add(userId);
				return [];
			}
			if (q.includes("select user_id from learning_blacklist")) {
				const userId = values[0] as string;
				return blacklist.has(userId) ? [{ user_id: userId }] : [];
			}
			if (query.includes("INSERT INTO learned_posts")) {
				return [{ post_id: values[0] as string }];
			}
			if (query.includes("SELECT post_id FROM replied_posts")) {
				return [];
			}
			return [];
		}) as unknown as Sql;

		const client: CielClient = {
			raw: {} as unknown as CielClient["raw"],
			me: vi.fn().mockResolvedValue(me),
			timeline: vi.fn().mockResolvedValue({ items: [] }),
			createPost: vi
				.fn()
				.mockResolvedValue({ id: "reply_1", content: "test" } as Post),
			addReaction: vi.fn().mockResolvedValue(undefined),
			updateBio: vi.fn().mockResolvedValue(me),
		};

		const markov = new MarkovModel();

		return { sql, client, blacklist, markov };
	}

	it("handles '学習禁止' command by adding user to blacklist and reacting with 👍", async () => {
		const { sql, client, blacklist, markov } = createMockSetup();
		const bot = new ChiseiBot(sql, client, me, markov, []);

		const post: Post = {
			id: "post_opt_out",
			content: "@chisei 学習禁止",
			author: { id: "user_alice", username: "alice", createdAt: "" },
			createdAt: "",
			mentions: [{ username: "chisei" }],
		};

		await bot.handlePost(post);

		expect(blacklist.has("user_alice")).toBe(true);
		expect(client.addReaction).toHaveBeenCalledWith("post_opt_out", "👍");
		expect(client.createPost).not.toHaveBeenCalled(); // No reply post
	});

	it("handles '学習許可' command by removing user from blacklist and reacting with 👍", async () => {
		const { sql, client, blacklist, markov } = createMockSetup();
		blacklist.add("user_alice");
		const bot = new ChiseiBot(sql, client, me, markov, []);

		const post: Post = {
			id: "post_opt_in",
			content: "@chisei 学習許可",
			author: { id: "user_alice", username: "alice", createdAt: "" },
			createdAt: "",
			mentions: [{ username: "chisei" }],
		};

		await bot.handlePost(post);

		expect(blacklist.has("user_alice")).toBe(false);
		expect(client.addReaction).toHaveBeenCalledWith("post_opt_in", "👍");
		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("skips learning when author is blacklisted", async () => {
		const { sql, client, blacklist, markov } = createMockSetup();
		blacklist.add("user_bob");
		const bot = new ChiseiBot(sql, client, me, markov, []);

		const post: Post = {
			id: "post_bob_1",
			content: "今日はラーメンを食べたよ",
			author: { id: "user_bob", username: "bob", createdAt: "" },
			createdAt: "",
		};

		await bot.handlePost(post);

		expect(markov.edgeCount).toBe(0);
	});

	it("syncs bio with formatted word count", async () => {
		const { sql, client, markov } = createMockSetup();
		markov.ingest(["今日", "は", "晴れ"]);
		const bot = new ChiseiBot(sql, client, me, markov, []);

		await bot.syncBio();

		expect(client.updateBio).toHaveBeenCalledTimes(1);
		const updatedBio = vi.mocked(client.updateBio).mock.calls[0][0];
		expect(updatedBio).toContain(`覚えた言葉: ${markov.edgeCount}`);
	});
});
