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
		const learnedPosts = new Set<string>();

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
				const postId = values[0] as string;
				if (learnedPosts.has(postId)) {
					return [];
				}
				learnedPosts.add(postId);
				return [{ post_id: postId }];
			}
			if (query.includes("SELECT post_id FROM replied_posts")) {
				return [];
			}
			if (q.includes("select max(learned_at)")) {
				return [{ last_learned_at: new Date("2026-09-21T09:00:00.000Z") }];
			}
			return [];
		}) as unknown as Sql;

		const client: CielClient = {
			raw: {} as unknown as CielClient["raw"],
			me: vi.fn().mockResolvedValue(me),
			timeline: vi.fn().mockResolvedValue({ items: [] }),
			userPosts: vi.fn().mockResolvedValue({ items: [] }),
			createPost: vi.fn().mockImplementation(async ({ content, parentId }) => ({
				id: "reply_1",
				content,
				parentId,
				author: me,
				createdAt: "",
			})),
			addReaction: vi.fn().mockResolvedValue(undefined),
			updateBio: vi.fn().mockResolvedValue(me),
		};

		const markov = new MarkovModel();

		return { sql, client, blacklist, learnedPosts, markov };
	}

	it("learns its own posts once without replying", async () => {
		const { sql, client, learnedPosts, markov } = createMockSetup();
		const bot = new ChiseiBot(sql, client, me, markov, []);
		const learn = vi.spyOn(markov, "learn");
		const post = {
			id: "self_1",
			content: "ことばで遊ぶ",
			author: me,
			createdAt: "",
		} as Post;

		await bot.handlePost(post);
		await bot.handlePost(post);

		expect(learnedPosts.has(post.id)).toBe(true);
		expect(learn).toHaveBeenCalledTimes(1);
		expect(learn).toHaveBeenCalledWith(sql, expect.any(Array), me.id);
		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("loads every page of its own post history", async () => {
		const { sql, client, learnedPosts, markov } = createMockSetup();
		const first = {
			id: "self_old",
			content: "ころころ言葉",
			author: me,
			createdAt: "",
		} as Post;
		const second = { ...first, id: "self_new", content: "言葉ころり" };
		vi.mocked(client.userPosts)
			.mockResolvedValueOnce({ items: [second], nextCursor: "older" })
			.mockResolvedValueOnce({ items: [first] });
		const bot = new ChiseiBot(sql, client, me, markov, []);

		await bot.learnOwnHistory();

		expect(client.userPosts).toHaveBeenNthCalledWith(1, me.username, {
			limit: 100,
			cursor: undefined,
		});
		expect(client.userPosts).toHaveBeenNthCalledWith(2, me.username, {
			limit: 100,
			cursor: "older",
		});
		expect(learnedPosts).toEqual(new Set(["self_old", "self_new"]));
	});

	it.each([
		[0.29, 1],
		[0.3, undefined],
	])(
		"uses the bot persona with the 30/70 length split at random=%s",
		async (random, maxTokens) => {
			const { sql, client, learnedPosts, markov } = createMockSetup();
			const generate = vi.spyOn(markov, "generate").mockReturnValue(["ころり"]);
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(random);
			try {
				const bot = new ChiseiBot(sql, client, me, markov, []);
				await bot.postSolo();

				expect(generate).toHaveBeenCalledWith([], me.id, maxTokens);
				expect(learnedPosts.has("reply_1")).toBe(true);
			} finally {
				randomSpy.mockRestore();
			}
		},
	);

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
		// 2026-09-21T09:00:00Z == 18:00 JST
		expect(updatedBio).toContain("(最終更新: 2026/09/21 18:00:00)");
	});

	it("skips bio sync when nothing changed", async () => {
		const { sql, client, markov } = createMockSetup();
		markov.ingest(["今日", "は", "晴れ"]);
		const bot = new ChiseiBot(sql, client, me, markov, []);

		await bot.syncBio();
		await bot.syncBio();

		expect(client.updateBio).toHaveBeenCalledTimes(1);
	});
});
