import { describe, expect, it, vi } from "vitest";
import { isBadEndingTag, isBadStartTag, MarkovModel } from "./bot/markov.js";
import {
	buildReply,
	formatBio,
	formatTimestamp,
	isMentionForBot,
	parseOptCommand,
} from "./bot/text.js";
import { BOS } from "./bot/tokenizer.js";

describe("isMentionForBot", () => {
	const post = {
		id: "1",
		content: "hello @chisei 元気？",
		author: { id: "u1", username: "neko" },
		mentions: [{ username: "chisei" }],
	};

	it("detects structured mentions", () => {
		expect(isMentionForBot(post, "chisei")).toBe(true);
	});

	it("detects @username in text", () => {
		expect(isMentionForBot({ ...post, mentions: [] }, "chisei")).toBe(true);
	});

	it("ignores other users", () => {
		expect(
			isMentionForBot(
				{ ...post, content: "hello", mentions: [{ username: "other" }] },
				"chisei",
			),
		).toBe(false);
	});

	it("matches optional wake words", () => {
		expect(
			isMentionForBot(
				{ ...post, content: "ちせい おはよ", mentions: [] },
				"chisei",
				["ちせい"],
			),
		).toBe(true);
	});
});

describe("buildReply", () => {
	it("prefixes the target mention and stays within 300 chars", () => {
		const reply = buildReply("chisei", "neko", "もぐもぐ");
		expect(reply.startsWith("@neko ")).toBe(true);
		expect(reply.length).toBeLessThanOrEqual(300);
	});
});

describe("parseOptCommand", () => {
	it("detects opt-out command with mention", () => {
		expect(
			parseOptCommand(
				{
					id: "1",
					content: "@chisei 学習禁止",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_out");
		expect(
			parseOptCommand(
				{
					id: "2",
					content: "学習禁止 @chisei",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_out");
		expect(
			parseOptCommand(
				{
					id: "3",
					content: "学習禁止！",
					author: { id: "u1", username: "u" },
					mentions: [{ username: "chisei" }],
				},
				"chisei",
			),
		).toBe("opt_out");
		expect(
			parseOptCommand(
				{
					id: "4",
					content: "@chisei オプトアウト",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_out");
	});

	it("detects opt-in command with mention", () => {
		expect(
			parseOptCommand(
				{
					id: "5",
					content: "@chisei 学習許可",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_in");
		expect(
			parseOptCommand(
				{
					id: "6",
					content: "学習許可 @chisei",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_in");
		expect(
			parseOptCommand(
				{
					id: "7",
					content: "学習再開",
					author: { id: "u1", username: "u" },
					mentions: [{ username: "chisei" }],
				},
				"chisei",
			),
		).toBe("opt_in");
	});

	it("returns null for non-command posts", () => {
		expect(
			parseOptCommand(
				{
					id: "8",
					content: "@chisei 今日はいい天気ですね",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBeNull();
		expect(
			parseOptCommand(
				{
					id: "9",
					content: "学習禁止",
					author: { id: "u1", username: "u" },
					mentions: [{ username: "other" }],
				},
				"chisei",
			),
		).toBeNull();
		expect(
			parseOptCommand(
				{
					id: "10",
					content: "@chisei 学習禁止についてどう思う？",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBeNull();
	});
});

describe("formatBio", () => {
	it("formats bio text correctly with word count", () => {
		const bio = formatBio(42);
		expect(bio).toContain("覚えた言葉: 42");
		expect(bio).toContain('"(メンション) 学習禁止"でブラックリスト登録');
		expect(bio).toContain('"(メンション) 学習許可"でブラックリストから除外');
	});

	it("appends the last-updated timestamp in JST slash format", () => {
		const bio = formatBio(284, new Date("2012-04-04T03:34:56.000Z"));
		expect(bio).toContain("覚えた言葉: 284");
		expect(bio).toContain("(最終更新: 2012/04/04 12:34:56)");
	});

	it("omits the timestamp line when never learned", () => {
		expect(formatBio(0, null)).not.toContain("最終更新");
		expect(formatBio(0)).not.toContain("最終更新");
	});

	it("formats timestamps as JST slash dates", () => {
		expect(formatTimestamp(new Date("2012-04-04T03:34:56.000Z"))).toBe(
			"2012/04/04 12:34:56",
		);
	});
});

describe("MFM parsing and tokenization", () => {
	it("extracts text while stripping MFM decorators, code, mentions, and urls", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const input =
			"こんにちは $[tada 楽しい] @user https://example.com `inline code` **太字**";
		const tokens = await tokenize(input);
		expect(tokens).toContain("こんにちは");
		expect(tokens).toContain("楽しい");
		expect(tokens).toContain("太字");
		expect(tokens).not.toContain("@user");
		expect(tokens).not.toContain("https://example.com");
		expect(tokens).not.toContain("inline");
		expect(tokens).not.toContain("code");
	});

	it("drops unicode emojis and custom emoji literals as decoration", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const input = "猫ちゃん 😊 :custom_cat: $[shake :super_dog:] もぐもぐ";
		const tokens = await tokenize(input);
		expect(tokens).toContain("猫");
		expect(tokens).toContain("もぐもぐ");
		expect(tokens).not.toContain("😊");
		expect(tokens).not.toContain(":custom_cat:");
		expect(tokens).not.toContain(":super_dog:");
		expect(tokens).not.toContain("custom_cat");
	});

	it("strips bare domains, emails, markdown links, and pasted addresses", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const tokens = await tokenize(
			"見て example.com と www.example.com/path だよ",
		);
		expect(tokens).toContain("見");
		expect(tokens.join("")).not.toMatch(/example|com/);

		const mailTokens = await tokenize("連絡は foo@example.com まで");
		expect(mailTokens.join("")).not.toMatch(/foo|example|com/);
		expect(mailTokens.join("")).toMatch(/連絡/);

		const mdTokens = await tokenize("[公式サイト](https://example.com)を見て");
		expect(mdTokens.join("")).toMatch(/公式サイト/);
		expect(mdTokens.join("")).not.toMatch(/example|https/);

		const ipTokens = await tokenize("鯖は 192.168.0.1:3000 だ");
		expect(ipTokens.join("")).not.toMatch(/192|168|3000/);
	});

	it("splits Japanese into morphemes instead of whole posts", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const tokens = await tokenize("今日はいい天気ですね");
		expect(tokens).toEqual(["今日", "は", "いい", "天気", "です", "ね"]);
	});

	it("strips punctuation at learn time (decorations belong to speech)", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const tokens = await tokenize("わーい!やったー。すごい?");
		expect(tokens.length).toBeGreaterThan(1);
		for (const token of tokens) {
			expect(token).not.toMatch(/^[！？!？。、，．…ー〜～\s]+$/u);
		}
		expect(tokens).not.toContain("!");
		expect(tokens).not.toContain("?");
		expect(tokens).not.toContain("、");
		expect(tokens).not.toContain("。");
	});

	it("keeps part-of-speech tags for learned morphemes", async () => {
		const { tokenizeDetailed } = await import("./bot/tokenizer.js");
		const detailed = await tokenizeDetailed("今日はいい天気ですね");
		const byText = new Map(detailed.map((token) => [token.text, token]));
		expect(byText.get("今日")?.pos).toBe("名詞");
		expect(byText.get("は")?.pos).toBe("助詞");
		expect(byText.get("は")?.detail).toBe("係助詞");
		expect(byText.get("ね")?.pos).toBe("助詞");
		expect(byText.get("ね")?.detail).toBe("終助詞");
	});

	it("returns no tokens for punctuation-only input", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		expect(await tokenize("、。， question?")).not.toContain("、");
		expect(await tokenize("、。， question?")).not.toContain("。");
		expect(await tokenize("")).toEqual([]);
	});

	it("splits posts into sentences for per-sentence learning", async () => {
		const { splitSentences } = await import("./bot/tokenizer.js");
		expect(splitSentences("わーい!やったー。すごい?")).toEqual([
			"わーい!",
			"やったー。",
			"すごい?",
		]);
		expect(splitSentences("ひとこと")).toEqual(["ひとこと"]);
		expect(splitSentences("")).toEqual([]);
	});
});

describe("MarkovModel", () => {
	it("labels observed token positions", () => {
		const model = new MarkovModel();
		model.ingest(["クライアントは", "動く"]);

		expect(model.canStart("クライアントは")).toBe(true);
		expect(model.canEnd("クライアントは")).toBe(false);
		expect(model.canStart("動く")).toBe(false);
		expect(model.canEnd("動く")).toBe(true);
	});

	it("does not stop early on a token never observed at the end", () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			// preventVerbatim を切った決定論的モードでの旧来の挙動を確認する
			const model = new MarkovModel({
				variety: 1,
				temperature: 1,
				preventVerbatim: false,
			});
			model.ingest(["これは", "つまり", "クライアントは", "動く"]);

			const output = model.generate([]);
			expect(output.at(-1)).toBe("動く");
			expect(output).toContain("クライアントは");
		} finally {
			random.mockRestore();
		}
	});

	it("generates tokens after learning", () => {
		const model = new MarkovModel();
		model.ingest(["今日", "は", "いい", "天気"]);
		model.ingest(["今日", "は", "ごはん"]);
		// verbatim 防止により学習文そのままの試行は空配列になるため、
		// 再結合が出るまで複数回試して少なくとも1回は生成されることを確認する
		let out: string[] = [];
		for (let i = 0; i < 100 && out.length === 0; i += 1) {
			out = model.generate(["今日"]);
		}
		expect(out.length).toBeGreaterThan(0);
		expect(out.includes(BOS)).toBe(false);
	});

	it("caps utterance length with a per-call maxTokens override", () => {
		const model = new MarkovModel();
		model.ingest(["今日", "は", "いい", "天気", "です", "ね", "よ"]);
		model.ingest(["今日", "は", "ごはん", "を", "食べる"]);
		for (let i = 0; i < 50; i += 1) {
			const out = model.generate([], undefined, 4);
			expect(out.length).toBeLessThanOrEqual(4);
		}
	});

	it("changes generated utterances when maxTokens changes", () => {
		// 長さノブ自体の検証のため verbatim 拒否は切る (文末は「する」のみなので
		// 早期切り上げが起きず、同一文が上限いっぱいまで伸びる)
		const model = new MarkovModel({ preventVerbatim: false });
		model.ingest(["春", "の", "朝", "に", "猫", "が", "伸び", "する"]);
		for (let i = 0; i < 50; i += 1) {
			expect(model.generate([], undefined, 4).length).toBeLessThanOrEqual(4);
		}
		let long = 0;
		for (let i = 0; i < 100; i += 1) {
			if (model.generate([], undefined, 24).length > 4) {
				long += 1;
			}
		}
		expect(long).toBeGreaterThan(0);
	});

	it("recombines fragments instead of always reproducing training data", () => {
		const model = new MarkovModel();
		model.ingest(["a", "b", "c", "d"]);
		model.ingest(["x", "b", "z"]);
		const distinct = new Set<string>();
		for (let i = 0; i < 100; i += 1) {
			const out = model.generate([]);
			if (out.length > 0) {
				distinct.add(out.join(" "));
			}
		}
		// Backoff should sometimes join "a b" with "z" (never learned verbatim)
		expect(distinct.size).toBeGreaterThanOrEqual(2);
	});

	it("variety 0 reproduces the single memorized path deterministically", () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			const model = new MarkovModel({ variety: 0, temperature: 1 });
			model.ingest(["a", "b", "c"]);
			expect(model.generate([])).toEqual(["a", "b", "c"]);
		} finally {
			random.mockRestore();
		}
	});

	it("rejects verbatim reproductions of the only learned sentence", () => {
		const model = new MarkovModel();
		model.ingest(["a", "b", "c", "d", "e"]);
		// 唯一の学習文しか生成できない場合はフォールバック用の空配列を返す
		expect(model.generate([])).toEqual([]);
	});

	it("never outputs learned sentences once recombinations exist", () => {
		const model = new MarkovModel();
		model.ingest(["a", "b", "c", "d"]);
		model.ingest(["x", "b", "z"]);
		const banned = new Set(["a b c d", "x b z"]);
		let seenNovel = false;
		for (let i = 0; i < 200; i += 1) {
			const out = model.generate([]);
			if (out.length === 0) {
				continue;
			}
			expect(banned.has(out.join(" "))).toBe(false);
			seenNovel = true;
		}
		expect(seenNovel).toBe(true);
	});

	it("detects partial verbatim runs, not just exact matches", () => {
		const model = new MarkovModel({ maxVerbatimNgram: 4 });
		model.ingest([
			"新しい",
			"イメージ",
			"を",
			"デプロイ",
			"した",
			"とき",
			"に",
		]);
		// 4トークン以上の連続一致は丸暗記とみなす
		expect(model.isBannedSequence(["イメージ", "を", "デプロイ", "した"])).toBe(
			true,
		);
		expect(model.isBannedSequence(["を", "デプロイ", "した"])).toBe(false);
		// 短い出力の完全一致は学習文そのものなので ban
		expect(model.isBannedSequence(["x", "b", "z"])).toBe(false);
		model.ingest(["x", "b", "z"]);
		expect(model.isBannedSequence(["x", "b", "z"])).toBe(true);
	});

	it("uses POS categories to avoid fragmentary endings and starts", () => {
		const model = new MarkovModel();
		model.ingest(["今日", "は", "いい", "天気", "です", "ね"], "", [
			{ pos: "名詞", detail: "副詞可能" },
			{ pos: "助詞", detail: "係助詞" },
			{ pos: "形容詞", detail: "自立" },
			{ pos: "名詞", detail: "一般" },
			{ pos: "助動詞", detail: "*" },
			{ pos: "助詞", detail: "終助詞" },
		]);
		expect(model.dominantPosTag("は")).toEqual({
			pos: "助詞",
			detail: "係助詞",
		});
		// 格助詞・係助詞終わりは断片なので避ける。終助詞終わりは自然なので許す。
		expect(model.isGoodEnding("は")).toBe(false);
		expect(model.isGoodEnding("ね")).toBe(true);
		expect(model.isGoodEnding("です")).toBe(true);
		expect(model.isGoodEnding("天気")).toBe(true);
		// 助詞始まりは避ける。名詞始まりは許す。
		expect(model.isGoodStart("は")).toBe(false);
		expect(model.isGoodStart("今日")).toBe(true);
		// 未知語は制限しない
		expect(model.isGoodEnding("未知語")).toBe(true);
		expect(model.isGoodStart("未知語")).toBe(true);
	});

	it("forbids standalone auxiliary/particle use like ております", () => {
		const model = new MarkovModel();
		model.ingest(["て", "おります"], "", [
			{ pos: "助詞", detail: "接続助詞" },
			{ pos: "助動詞", detail: "*" },
		]);
		model.ingest(["猫", "が", "走る"], "", [
			{ pos: "名詞", detail: "一般" },
			{ pos: "助詞", detail: "格助詞" },
			{ pos: "動詞", detail: "自立" },
		]);
		// 付属語の単独使用は調教として禁じる
		expect(model.isStandaloneOk("て")).toBe(false);
		expect(model.isStandaloneOk("おります")).toBe(false);
		expect(model.isStandaloneOk("が")).toBe(false);
		// 自立語は単独でもよい。未知語は制限しない
		expect(model.isStandaloneOk("走る")).toBe(true);
		expect(model.isStandaloneOk("猫")).toBe(true);
		expect(model.isStandaloneOk("未知語")).toBe(true);
	});

	it("judges start/end suitability by POS category", () => {
		expect(isBadEndingTag("助詞", "格助詞")).toBe(true);
		expect(isBadEndingTag("助詞", "係助詞")).toBe(true);
		expect(isBadEndingTag("助詞", "終助詞")).toBe(false);
		expect(isBadEndingTag("助詞", "副助詞")).toBe(false);
		expect(isBadEndingTag("助動詞", "*")).toBe(false);
		expect(isBadEndingTag("接続詞", "*")).toBe(true);
		expect(isBadEndingTag("名詞", "一般")).toBe(false);
		expect(isBadEndingTag("名詞", "接尾")).toBe(false);
		expect(isBadStartTag("助詞")).toBe(true);
		expect(isBadStartTag("助動詞")).toBe(true);
		expect(isBadStartTag("名詞")).toBe(false);
		expect(isBadStartTag("名詞", "接尾")).toBe(true);
		expect(isBadStartTag("感動詞")).toBe(false);
	});

	it.each([
		{
			name: "語尾欠落コピー",
			source:
				"新しいイメージデプロイしたときに古いクライアントは新しいバージョンに切り替えるようにしてもらいたいなあ",
			parrot:
				"クライアントは新しいバージョンに切り替えるようにしてもらいたいなあ",
		},
		{
			name: "文またぎ結合コピー",
			source:
				"バックエンドだけでもラズパイはきつそうだから、どうしようって感じ",
			parrot:
				"バックエンドだけでもラズパイはきつそうだから、どうしようって感じ",
		},
		{
			name: "途中切り上げコピー",
			source:
				"集中してた頃はなんとも思わなかったけど、DBのマイグレーションやりやすくなって楽だ",
			parrot: "集中してた頃はなんとも思わなかったけど、DBの",
		},
	])(
		"parroting case $name is caught by the guards",
		async ({ source, parrot }) => {
			const { tokenize } = await import("./bot/tokenizer.js");
			const model = new MarkovModel();
			const sourceTokens = await tokenize(source);
			expect(sourceTokens.length).toBeGreaterThan(4);
			model.ingest(sourceTokens);
			const parrotTokens = await tokenize(parrot);
			// 部分的な丸暗記として検出できること (完全一致でなくても 4-gram で捕捉)
			expect(model.isBannedSequence(parrotTokens)).toBe(true);
		},
	);
});
