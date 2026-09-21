import { describe, expect, it, vi } from "vitest";
import { ChiseiBot } from "./bot/chisei.js";
import { MarkovModel } from "./bot/markov.js";
import type { CielClient, Post, User } from "./ciel/client.js";
import type { Db } from "./db.js";

describe("ChiseiBot", () => {
	const me: User = {
		id: "bot_123",
		username: "chisei",
		displayName: "知性bot",
		createdAt: new Date().toISOString(),
	};

	function createMockSetup() {
		const blacklist = new Set<string>();
		const learnedPosts = new Set<string>();
		const repliedPosts = new Set<string>();
		const labels = new Map<string, { canStart: boolean; canEnd: boolean }>();
		const learnedAt = new Date("2026-09-21T09:00:00.000Z");

		const db = {
			learnedPost: {
				createMany: vi.fn(async ({ data }) => {
					const postId = data[0].postId as string;
					if (learnedPosts.has(postId)) return { count: 0 };
					learnedPosts.add(postId);
					return { count: 1 };
				}),
				aggregate: vi.fn().mockResolvedValue({ _max: { learnedAt } }),
			},
			repliedPost: {
				findUnique: vi.fn(async ({ where }) =>
					repliedPosts.has(where.postId) ? { postId: where.postId } : null,
				),
				createMany: vi.fn(async ({ data }) => {
					repliedPosts.add(data[0].postId);
					return { count: 1 };
				}),
			},
			learningBlacklist: {
				upsert: vi.fn(async ({ where }) => {
					blacklist.add(where.userId);
					return { userId: where.userId };
				}),
				deleteMany: vi.fn(async ({ where }) => ({
					count: blacklist.delete(where.userId) ? 1 : 0,
				})),
				findUnique: vi.fn(async ({ where }) =>
					blacklist.has(where.userId) ? { userId: where.userId } : null,
				),
			},
			markovEdge: { upsert: vi.fn().mockResolvedValue({}) },
			markovTokenLabel: {
				upsert: vi.fn(async ({ where, create, update }) => {
					const current = labels.get(where.token);
					const next = current
						? {
								canStart: update.canStart ?? current.canStart,
								canEnd: update.canEnd ?? current.canEnd,
							}
						: {
								canStart: create.canStart ?? false,
								canEnd: create.canEnd ?? false,
							};
					labels.set(where.token, next);
					return { token: where.token, ...next };
				}),
			},
			$transaction: vi.fn(async (callback) => callback(db)),
		} as unknown as Db;

		const client: CielClient = {
			raw: {} as CielClient["raw"],
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

		return {
			db,
			client,
			blacklist,
			learnedPosts,
			labels,
			markov: new MarkovModel(),
		};
	}

	it("learns its own posts transactionally once and labels their positions", async () => {
		const { db, client, learnedPosts, labels, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		const post = {
			id: "self_1",
			content: "クライアントは 動く",
			author: me,
			createdAt: "",
		} as Post;

		await bot.handlePost(post);
		await bot.handlePost(post);

		expect(db.$transaction).toHaveBeenCalledTimes(2);
		expect(learnedPosts).toEqual(new Set([post.id]));
		expect(labels.get("クライアントは")).toEqual({
			canStart: true,
			canEnd: false,
		});
		expect(labels.get("動く")).toEqual({ canStart: false, canEnd: true });

		await bot.handlePost({ ...post, id: "self_2", content: "クライアントは" });
		expect(labels.get("クライアントは")).toEqual({
			canStart: true,
			canEnd: true,
		});
		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("loads every page of its own post history", async () => {
		const { db, client, learnedPosts, markov } = createMockSetup();
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
		const bot = new ChiseiBot(db, client, me, markov, []);

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
		[0, "!"],
		[0.2, "..."],
		[0.4, "?"],
		[0.6, "。"],
	] as const)(
		"adds the selected playful ending at roll=%s",
		async (roll, ending) => {
			const { db, client, markov } = createMockSetup();
			vi.spyOn(markov, "generate").mockReturnValue(["ころり"]);
			vi.spyOn(markov, "canEnd").mockReturnValue(true);
			const random = vi
				.spyOn(Math, "random")
				.mockReturnValueOnce(0.1)
				.mockReturnValueOnce(roll);
			try {
				await new ChiseiBot(db, client, me, markov, []).postSolo();
				expect(client.createPost).toHaveBeenCalledWith({
					content: `ころり${ending}`,
				});
			} finally {
				random.mockRestore();
			}
		},
	);

	it("continues a non-terminal token before adding an ending", async () => {
		const { db, client, markov } = createMockSetup();
		vi.spyOn(markov, "generate").mockReturnValue(["クライアントは", "動く"]);
		vi.spyOn(markov, "canEnd").mockImplementation((token) => token === "動く");
		const random = vi
			.spyOn(Math, "random")
			.mockReturnValueOnce(0.1)
			.mockReturnValueOnce(0);
		try {
			await new ChiseiBot(db, client, me, markov, []).postSolo();
			expect(client.createPost).toHaveBeenCalledWith({
				content: "クライアントは動く!",
			});
		} finally {
			random.mockRestore();
		}
	});

	it("uses an independently generated sentence after the comma prefix", async () => {
		const { db, client, markov } = createMockSetup();
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValueOnce(["クライアントは", "動く"])
			.mockReturnValueOnce(["猫が", "眠る"]);
		const random = vi
			.spyOn(Math, "random")
			.mockReturnValueOnce(0.1)
			.mockReturnValueOnce(0.8);
		try {
			await new ChiseiBot(db, client, me, markov, []).postSolo();
			expect(generate).toHaveBeenCalledTimes(2);
			expect(client.createPost).toHaveBeenCalledWith({
				content: "クライアントは、猫が眠る",
			});
		} finally {
			random.mockRestore();
		}
	});

	it("keeps normal Markov speech in the remaining 70 percent", async () => {
		const { db, client, markov } = createMockSetup();
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValue(["ころり", "ことば"]);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.3);
		try {
			await new ChiseiBot(db, client, me, markov, []).postSolo();
			expect(generate).toHaveBeenCalledWith([], me.id);
			expect(client.createPost).toHaveBeenCalledWith({
				content: "ころりことば",
			});
		} finally {
			random.mockRestore();
		}
	});

	it("handles learning opt-out and opt-in", async () => {
		const { db, client, blacklist, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		const post = {
			id: "post_opt",
			content: "@chisei 学習禁止",
			author: { id: "user_alice", username: "alice", createdAt: "" },
			createdAt: "",
			mentions: [{ username: "chisei" }],
		} as Post;

		await bot.handlePost(post);
		expect(blacklist.has("user_alice")).toBe(true);
		expect(client.addReaction).toHaveBeenCalledWith(post.id, "👍");

		await bot.handlePost({
			...post,
			id: "post_in",
			content: "@chisei 学習許可",
		});
		expect(blacklist.has("user_alice")).toBe(false);
		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("skips learning when author is blacklisted", async () => {
		const { db, client, blacklist, markov } = createMockSetup();
		blacklist.add("user_bob");
		const bot = new ChiseiBot(db, client, me, markov, []);

		await bot.handlePost({
			id: "post_bob_1",
			content: "今日はラーメンを食べたよ",
			author: { id: "user_bob", username: "bob", createdAt: "" },
			createdAt: "",
		} as Post);

		expect(markov.edgeCount).toBe(0);
	});

	it("syncs the bio once while its inputs remain unchanged", async () => {
		const { db, client, markov } = createMockSetup();
		markov.ingest(["今日", "は", "晴れ"]);
		const bot = new ChiseiBot(db, client, me, markov, []);

		await bot.syncBio();
		await bot.syncBio();

		expect(client.updateBio).toHaveBeenCalledTimes(1);
		const bio = vi.mocked(client.updateBio).mock.calls[0][0];
		expect(bio).toContain(`覚えた言葉: ${markov.edgeCount}`);
		expect(bio).toContain("(最終更新: 2026/09/21 18:00:00)");
	});
});
