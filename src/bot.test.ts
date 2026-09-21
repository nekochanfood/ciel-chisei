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
			markovSequence: { upsert: vi.fn().mockResolvedValue({}) },
			markovTokenPos: { upsert: vi.fn().mockResolvedValue({}) },
			markovTokenForm: { upsert: vi.fn().mockResolvedValue({}) },
			markovPattern: { upsert: vi.fn().mockResolvedValue({}) },
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

	/** mock generate の出力を「投稿可能」とみなす (isPostable の検証を素通しさせる)。 */
	function stubPostableOutput(markov: MarkovModel) {
		vi.spyOn(markov, "canStart").mockReturnValue(true);
		vi.spyOn(markov, "isGoodStart").mockReturnValue(true);
		vi.spyOn(markov, "canEnd").mockReturnValue(true);
		vi.spyOn(markov, "isGoodEnding").mockReturnValue(true);
		vi.spyOn(markov, "isBannedSequence").mockReturnValue(false);
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
		// kuromoji 形態素単位で学習される: クライアント/は/動く
		expect(labels.get("クライアント")).toEqual({
			canStart: true,
			canEnd: false,
		});
		expect(labels.get("動く")).toEqual({ canStart: false, canEnd: true });

		await bot.handlePost({ ...post, id: "self_2", content: "クライアントは" });
		expect(labels.get("クライアント")).toEqual({
			canStart: true,
			canEnd: false,
		});
		expect(labels.get("は")).toEqual({ canStart: false, canEnd: true });
		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("learns multi-sentence posts per sentence without punctuation", async () => {
		const { db, client, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		const post = {
			id: "multi_1",
			content: "わーい!やったー。すごい?",
			author: { id: "user_x", username: "x", createdAt: "" },
			createdAt: "",
		} as Post;

		await bot.handlePost(post);

		// 3文それぞれが別シーケンスとして保存される (文またぎの丸暗記を防ぐ)
		const seqUpsert = vi.mocked(db.markovSequence.upsert);
		expect(seqUpsert).toHaveBeenCalledTimes(3);
		const parsed = seqUpsert.mock.calls.map((call) =>
			JSON.parse(call[0].create.text),
		);
		expect(parsed).toContainEqual(["わーい"]);
		// 句読点は学習されない (発話時の装飾レイヤーに任せる)
		for (const tokens of parsed) {
			for (const token of tokens) {
				expect(token).not.toMatch(/^[！？!？。、…\s]+$/u);
			}
		}
		// 品詞カテゴリも保存される
		expect(db.markovTokenPos.upsert).toHaveBeenCalled();
		const posCalls = vi.mocked(db.markovTokenPos.upsert).mock.calls;
		expect(posCalls.some((call) => call[0].create.token === "わーい")).toBe(
			true,
		);
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
		[0, "！"],
		[0.2, "…"],
		[0.4, "？"],
		[0.6, "。"],
	] as const)(
		"adds the selected playful ending at roll=%s",
		async (roll, ending) => {
			const { db, client, markov } = createMockSetup();
			vi.spyOn(markov, "generate").mockReturnValue(["ころり"]);
			stubPostableOutput(markov);
			vi.spyOn(markov, "canEnd").mockReturnValue(true);
			const random = vi
				.spyOn(Math, "random")
				.mockReturnValueOnce(0) // soloPostRate チェック (通過)
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
		stubPostableOutput(markov);
		vi.spyOn(markov, "canEnd").mockImplementation((token) => token === "動く");
		const random = vi
			.spyOn(Math, "random")
			.mockReturnValueOnce(0) // soloPostRate チェック (通過)
			.mockReturnValueOnce(0.1)
			.mockReturnValueOnce(0);
		try {
			await new ChiseiBot(db, client, me, markov, []).postSolo();
			expect(client.createPost).toHaveBeenCalledWith({
				content: "クライアントは動く！",
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
			.mockReturnValue(["猫が", "眠る"]);
		stubPostableOutput(markov);
		const random = vi
			.spyOn(Math, "random")
			.mockReturnValueOnce(0) // soloPostRate チェック (通過)
			.mockReturnValueOnce(0.1)
			.mockReturnValueOnce(0.8)
			.mockReturnValue(0.5);
		try {
			await new ChiseiBot(db, client, me, markov, []).postSolo();
			// 目標ラウンドで3候補を集め、最良(ここでは同点の先頭)を見出しに使う
			expect(generate).toHaveBeenCalledTimes(4);
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
		stubPostableOutput(markov);
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

	it("skips replies when replyRate is 0 but still learns", async () => {
		const { db, client, learnedPosts, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, [], { replyRate: 0 });
		const post = {
			id: "post_skip",
			content: "@chisei 今日はいい天気ですね",
			author: { id: "user_carl", username: "carl", createdAt: "" },
			createdAt: "",
			mentions: [{ username: "chisei" }],
		} as Post;

		await bot.handlePost(post);

		expect(learnedPosts.has(post.id)).toBe(true);
		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("skips solo posts when soloPostRate is 0", async () => {
		const { db, client, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, [], {
			soloPostRate: 0,
		});

		await bot.postSolo();

		expect(client.createPost).not.toHaveBeenCalled();
	});

	it("scales reply length to the incoming post length", async () => {
		const { db, client, markov } = createMockSetup();
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValue(["今日", "は", "晴れ"]);
		stubPostableOutput(markov);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const bot = new ChiseiBot(db, client, me, markov, []);
			const post = {
				id: "post_len",
				content: "@chisei 今日はいい天気ですね",
				author: { id: "user_dana", username: "dana", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post;

			await bot.handlePost(post);

			expect(client.createPost).toHaveBeenCalledTimes(1);
			const [seed, authorId, maxTokens] = generate.mock.calls[0];
			// 相手の文のトークン数 × 係数(1) がそのまま上限になる
			expect(authorId).toBe(me.id);
			expect(maxTokens).toBe(seed.length);
			expect(maxTokens).toBeGreaterThan(1);
		} finally {
			random.mockRestore();
		}
	});

	it("retries targeted length before falling back to full length", async () => {
		const { db, client, markov } = createMockSetup();
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValueOnce([])
			.mockReturnValue(["今日", "は", "晴れ"]);
		stubPostableOutput(markov);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const bot = new ChiseiBot(db, client, me, markov, []);
			const post = {
				id: "post_retry",
				content: "@chisei おはよう",
				author: { id: "user_finn", username: "finn", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post;

			await bot.handlePost(post);

			// 目標長ラウンドで3候補を集めて最良を採用する (通常長には進まない)
			expect(generate).toHaveBeenCalledTimes(3);
			expect(generate.mock.calls[0].length).toBe(3);
			expect(generate.mock.calls[1].length).toBe(3);
			expect(generate.mock.calls[2].length).toBe(3);
			expect(client.createPost).toHaveBeenCalledTimes(1);
		} finally {
			random.mockRestore();
		}
	});

	it("retries with full length when targeted generation keeps failing", async () => {
		const { db, client, markov } = createMockSetup();
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValueOnce([])
			.mockReturnValueOnce([])
			.mockReturnValueOnce([])
			.mockReturnValue(["今日", "は", "晴れ"]);
		stubPostableOutput(markov);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const bot = new ChiseiBot(db, client, me, markov, []);
			await bot.handlePost({
				id: "post_retry_full",
				content: "@chisei おはよう",
				author: { id: "user_finn", username: "finn", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post);

			// 目標長3回→通常長ラウンド3回 (2引数) で最良を採用する
			expect(generate).toHaveBeenCalledTimes(6);
			expect(generate.mock.calls[0].length).toBe(3);
			expect(generate.mock.calls[2].length).toBe(3);
			expect(generate.mock.calls[3].length).toBe(2);
			expect(generate.mock.calls[5].length).toBe(2);
			expect(client.createPost).toHaveBeenCalledTimes(1);
		} finally {
			random.mockRestore();
		}
	});

	it("regenerates instead of posting a particle-led fragment", async () => {
		const { db, client, markov } = createMockSetup();
		// 実モデルに語彙を与え、「明日は雨」だけが投稿可能になるよう組む
		markov.ingest(["今日", "は", "晴れ"]);
		markov.ingest(["今日", "は", "雨"]);
		markov.ingest(["明日", "は", "晴れ"]);
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValueOnce(["が", "見付かり", "がち"])
			.mockReturnValue(["明日", "は", "雨"]);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const bot = new ChiseiBot(db, client, me, markov, []);
			await bot.handlePost({
				id: "post_frag",
				content: "@chisei こんにちは",
				author: { id: "user_gus", username: "gus", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post);

			// 「が」始まりは実モデルの canStart に弾かれ、残り候補の最良が投稿される
			expect(generate).toHaveBeenCalledTimes(3);
			expect(client.createPost).toHaveBeenCalledWith({
				content: "@gus 明日は雨",
				parentId: "post_frag",
			});
		} finally {
			random.mockRestore();
		}
	});

	it("keeps comma-prefixed replies within the token budget", async () => {
		const { db, client, markov } = createMockSetup();
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValue(["今日", "は", "晴れ"]);
		stubPostableOutput(markov);
		// 連鎖の長さ配分を検証するため文型候補は外す
		vi.spyOn(markov, "generateFromPattern").mockReturnValue([]);
		// rate通過→playful→「、」選択 (idx 4)
		const random = vi
			.spyOn(Math, "random")
			.mockReturnValueOnce(0.5)
			.mockReturnValueOnce(0.1)
			.mockReturnValueOnce(0.8)
			.mockReturnValue(0.5);
		try {
			const bot = new ChiseiBot(db, client, me, markov, []);
			await bot.handlePost({
				id: "post_budget",
				content: "@chisei 今日はいい天気ですね",
				author: { id: "user_hank", username: "hank", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post);

			// 見出し用ラウンド3回＋後半1回。後半は目標-1が渡る
			expect(generate).toHaveBeenCalledTimes(4);
			const target = generate.mock.calls[0][2] as number;
			// 後半は「見出し1＋後半 ≤ 目標」になるよう目標-1が渡る
			expect(generate.mock.calls[3][2]).toBe(target - 1);
			const posted = vi.mocked(client.createPost).mock.calls[0][0]
				.content as string;
			expect(posted.includes("、")).toBe(true);
		} finally {
			random.mockRestore();
		}
	});

	it("rejects clippings with no content words (ております / そしてです)", async () => {
		const { db, client, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		// 断片の品詞を学習させる
		markov.ingest(["て", "おります"], "user_1", [
			{ pos: "助詞", detail: "接続助詞" },
			{ pos: "助動詞", detail: "*" },
		]);
		markov.ingest(["そして", "です", "ね"], "user_1", [
			{ pos: "接続詞", detail: "*" },
			{ pos: "助動詞", detail: "*" },
			{ pos: "助詞", detail: "終助詞" },
		]);
		markov.ingest(["さあ", "です"], "user_1", [
			{ pos: "感動詞", detail: "*" },
			{ pos: "助動詞", detail: "*" },
		]);
		// 良好候補の開始・終了だけ成立させる (完全一致の丸暗記にはしない)
		markov.ingest(["こんばんは", "元気"], "user_1");
		markov.ingest(["今日", "こんばんは"], "user_1");
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValueOnce(["て", "おります"])
			.mockReturnValueOnce(["そして", "です"])
			.mockReturnValue(["こんばんは"]);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
		try {
			await bot.postSolo();
			// 「ております」は文頭ゲートで、「そしてです」は自立語なしで弾かれる
			expect(generate).toHaveBeenCalledTimes(3);
			expect(client.createPost).toHaveBeenCalledTimes(1);
			expect(client.createPost.mock.calls[0]?.[0]?.content).toContain(
				"こんばんは",
			);
		} finally {
			random.mockRestore();
		}
	});

	it("marks fallback posts as seen without learning them as vocabulary", async () => {
		const { db, client, learnedPosts, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		const generate = vi.spyOn(markov, "generate").mockReturnValue([]);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
		try {
			await bot.postSolo();
			// 3回すべて空振りしてフォールバックになる (独り言は長さ指定なし1ラウンド)
			expect(generate).toHaveBeenCalledTimes(3);
			expect(client.createPost).toHaveBeenCalledTimes(1);
			// learned_posts には記録される (タイムライン経由の再学習も防ぐ) が…
			expect(learnedPosts.has("reply_1")).toBe(true);
			// …語彙 (エッジ) としては学習しない
			expect(db.markovEdge.upsert).not.toHaveBeenCalled();
			expect(markov.edgeCount).toBe(0);
		} finally {
			random.mockRestore();
		}
	});

	it("picks the highest-scoring candidate among retries", async () => {
		const { db, client, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		stubPostableOutput(markov);
		// 連鎖候補の選択を検証するため文型候補は外す
		vi.spyOn(markov, "generateFromPattern").mockReturnValue([]);
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValueOnce(["今日", "は", "晴れ"])
			.mockReturnValue(["猫", "は", "元気"]);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
		try {
			await bot.handlePost({
				id: "m_score",
				content: "@chisei 猫が好き",
				author: { id: "user_ivy", username: "ivy", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post);
			// 同じ長さ制限で3候補を集め、種文と語彙が重なる方を選ぶ
			expect(generate).toHaveBeenCalledTimes(3);
			expect(client.createPost).toHaveBeenCalledTimes(1);
			expect(client.createPost.mock.calls[0]?.[0]?.content).toContain(
				"猫は元気",
			);
		} finally {
			random.mockRestore();
		}
	});

	it("prefers a pattern-shaped candidate when patterns are learned", async () => {
		const { db, client, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, []);
		markov.ingest(["猫", "が", "走る"], "user_1", [
			{ pos: "名詞", detail: "一般" },
			{ pos: "助詞", detail: "格助詞" },
			{
				pos: "動詞",
				detail: "自立",
				basicForm: "走る",
				conjugation: "五段・ラ行",
			},
		]);
		markov.ingest(["犬", "は", "食べる"], "user_1", [
			{ pos: "名詞", detail: "一般" },
			{ pos: "助詞", detail: "係助詞" },
			{
				pos: "動詞",
				detail: "自立",
				basicForm: "食べる",
				conjugation: "一段",
			},
		]);
		// 文型「名詞 が 動詞:五段」を学習させる (五段スロットに一段は入らない)
		markov.ingestPattern(["名詞", "=が", "動詞:五段・ラ行"]);
		// 連鎖生成は文頭ゲートで落ちる候補だけ返す
		const generate = vi
			.spyOn(markov, "generate")
			.mockReturnValue(["今日", "は", "晴れ"]);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
		try {
			await bot.postSolo();
			// 文型候補 [犬,が,走る] が採用される (連鎖3回はいずれも不採用)
			expect(generate).toHaveBeenCalledTimes(3);
			expect(client.createPost).toHaveBeenCalledTimes(1);
			expect(client.createPost.mock.calls[0]?.[0]?.content).toBe("犬が走る");
		} finally {
			random.mockRestore();
		}
	});

	it("keeps long-form replies whole even on playful rolls", async () => {
		const { db, client, markov } = createMockSetup();
		const bot = new ChiseiBot(db, client, me, markov, [], {
			replyMinTokens: 50,
			replyMaxTokens: 100,
		});
		const long = Array.from({ length: 20 }, (_, i) => `t${i}`);
		const generate = vi.spyOn(markov, "generate").mockReturnValue(long);
		stubPostableOutput(markov);
		// rate通過→playful成立の目でも長文は短縮しない
		const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
		try {
			await bot.handlePost({
				id: "post_long",
				content: "@chisei 長文で語って",
				author: { id: "user_long", username: "ivy", createdAt: "" },
				createdAt: "",
				mentions: [{ username: "chisei" }],
			} as Post);
			// 目標50トークンで生成を呼び、文末装飾も切り詰めもしない
			expect(generate.mock.calls[0][2]).toBe(50);
			expect(client.createPost).toHaveBeenCalledTimes(1);
			const posted = vi.mocked(client.createPost).mock.calls[0][0]
				.content as string;
			expect(posted.endsWith("t19")).toBe(true);
		} finally {
			random.mockRestore();
		}
	});

	it("posts well-formed replies over many real generations (bot behavior)", async () => {
		const { FALLBACKS } = await import("./bot/text.js");
		const { tokenize } = await import("./bot/tokenizer.js");
		const { db, client, markov } = createMockSetup();
		// 短い文の語彙共有コーパス: 開始可能・終了可能の2-4トークン窓が
		// 繋ぎ変えで豊富に生まれる (硬い長文型だと有効窓が存在しない)。
		for (const sentence of [
			["猫", "が", "走る"],
			["猫", "が", "眠る"],
			["猫", "は", "元気"],
			["猫", "が", "ごはん", "を", "食べる"],
			["猫", "が", "昼寝", "を", "する"],
			["今日", "は", "ごはん"],
			["今日", "は", "晴れ"],
			["明日", "は", "雨"],
			["明日", "は", "散歩"],
			["ごはん", "を", "食べる"],
			["昼寝", "を", "する"],
			["散歩", "に", "行く"],
		]) {
			markov.ingest(sentence);
		}
		// 実乱数のまま生成する (決定論固定だと学習文の再現に収束してしまうため)。
		// 各返信はガード条件で個別に検証する。
		// シードは中期文にし、目標長に全文が収まるようにする (短すぎると切り詰めで終端不能になる)。
		{
			const bot = new ChiseiBot(db, client, me, markov, []);
			const seeds = [
				"猫が走るよ",
				"今日は晴れですね",
				"ごはんを食べる",
				"明日は散歩だ",
				"猫は元気だよ",
				"昼寝をする",
				"おはよう今日もがんばろう",
				"ねむいけど昼寝をする",
			];
			let checked = 0;
			for (let i = 0; i < seeds.length; i += 1) {
				await bot.handlePost({
					id: `post_loop_${i}`,
					content: `@chisei ${seeds[i]}`,
					author: { id: `user_loop_${i}`, username: `loop${i}`, createdAt: "" },
					createdAt: "",
					mentions: [{ username: "chisei" }],
				} as Post);
				const posted = vi.mocked(client.createPost).mock.calls[i][0]
					.content as string;
				const body = posted.replace(/^@\S+ /, "");
				if (FALLBACKS.includes(body)) {
					continue;
				}
				const tokens = await tokenize(body);
				expect(tokens.length).toBeGreaterThan(0);
				const first = tokens[0] as string;
				const last = tokens.at(-1) as string;
				// 「が…」「は、…」のような断片は投稿されない
				expect(markov.canStart(first)).toBe(true);
				expect(markov.isGoodStart(first)).toBe(true);
				expect(markov.canEnd(last)).toBe(true);
				expect(markov.isGoodEnding(last)).toBe(true);
				// ban は生成時 (isPostable) に検証済み。投稿後に自分の返信を
				// 学習するため、事後の isBannedSequence は必ず真になる。
				expect(tokens.length).toBeLessThanOrEqual(24);
				checked += 1;
			}
			// フォールバック素通しで終わらないこと (生成が機能している証拠)
			expect(checked).toBeGreaterThanOrEqual(5);
		}
		// 8往復×実delay(400-1600ms)のため既定5秒では足りない
	}, 60_000);

	it("clamps reply length to replyMinTokens/replyMaxTokens", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		for (const options of [
			{ replyMaxTokens: 3, expected: 3 },
			{ replyMinTokens: 30, replyMaxTokens: 100, expected: 30 },
		] as const) {
			const { db, client, markov } = createMockSetup();
			const generate = vi
				.spyOn(markov, "generate")
				.mockReturnValue(["今日", "は", "晴れ"]);
			stubPostableOutput(markov);
			const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
			try {
				const bot = new ChiseiBot(db, client, me, markov, [], options);
				const content = "@chisei 今日はいい天気ですね";
				await bot.handlePost({
					id: `post_clamp_${options.expected}`,
					content,
					author: { id: "user_erin", username: "erin", createdAt: "" },
					createdAt: "",
					mentions: [{ username: "chisei" }],
				} as Post);

				const seedLength = (await tokenize(content)).length;
				expect(seedLength).not.toBe(options.expected);
				expect(generate.mock.calls[0][2]).toBe(options.expected);
			} finally {
				random.mockRestore();
			}
		}
	});
});
