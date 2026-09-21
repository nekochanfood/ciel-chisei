import type { CielClient, Post, User } from "../ciel/client.js";
import {
	addBlacklist,
	type Db,
	isBlacklisted,
	removeBlacklist,
} from "../db.js";
import { CONTENT_POS, type MarkovModel, type PosTag } from "./markov.js";
import { buildSkeleton, type SkeletonCode } from "./pattern.js";
import {
	buildReply,
	clipContent,
	formatBio,
	isMentionForBot,
	isOwnPost,
	parseOptCommand,
	pickFallback,
} from "./text.js";
import {
	joinTokens,
	splitSentences,
	tokenize,
	tokenizeDetailed,
} from "./tokenizer.js";

const SHORT_UTTERANCE_RATE = 0.3;
/** この目標長を超えたら長文扱い (短縮装飾を抑止)。短文の既定挙動は変えない。 */
const LONGFORM_THRESHOLD_TOKENS = 12;
/** clip 予算の目安 (1トークンあたり文字数)。 */
const CHARS_PER_TOKEN = 4;
/** 長文かどうか。 */
function isLongform(maxTokens?: number): boolean {
	return (maxTokens ?? 0) > LONGFORM_THRESHOLD_TOKENS;
}
/** 発話時の装飾レイヤー (学習時は句読点を除去しているためここで付与する)。全角で統一する。 */
const PLAYFUL_ENDINGS = ["！", "…", "？", "。", "、"] as const;
/** 1文あたりの学習上限トークン数 (異常な長文の丸暗記を防ぐ)。長文生成の材料にするため余裕を持たせる。 */
const MAX_LEARN_TOKENS = 200;

export type ChiseiBotOptions = {
	/** 0..1。メンション・合言葉への返信確率。1で必ず返信。 */
	replyRate?: number;
	/** 0..1。独り言タイマー tick ごとの投稿確率。1で毎回投稿。 */
	soloPostRate?: number;
	/** 返信の長さ = 相手の文のトークン数 × この係数 (min/max で丸め)。 */
	replyLengthFactor?: number;
	/** 返信の最小トークン数。 */
	replyMinTokens?: number;
	/** 返信の最大トークン数。 */
	replyMaxTokens?: number;
};

export class ChiseiBot {
	private readonly inFlight = new Set<string>();
	private lastSyncedBioKey = "";
	private bioSyncTimer?: NodeJS.Timeout;
	private readonly replyRate: number;
	private readonly soloPostRate: number;
	private readonly replyLengthFactor: number;
	private readonly replyMinTokens: number;
	private readonly replyMaxTokens: number;

	constructor(
		private readonly db: Db,
		private readonly client: CielClient,
		private readonly me: User,
		private readonly markov: MarkovModel,
		private readonly wakeWords: string[],
		options: ChiseiBotOptions = {},
	) {
		this.replyRate = options.replyRate ?? 1;
		this.soloPostRate = options.soloPostRate ?? 1;
		this.replyLengthFactor = options.replyLengthFactor ?? 1;
		this.replyMinTokens = options.replyMinTokens ?? 2;
		this.replyMaxTokens = options.replyMaxTokens ?? 24;
	}

	async syncBio(): Promise<void> {
		try {
			const count = this.markov.edgeCount;
			const lastLearnedAt = await this.lastLearnedAt();
			// Refresh when the vocabulary OR the last-learned time changed
			// (re-learning known trigrams bumps counts without adding edges).
			const key = `${count}|${lastLearnedAt?.toISOString() ?? "-"}`;
			if (key === this.lastSyncedBioKey) {
				return;
			}
			const bio = formatBio(count, lastLearnedAt);
			await this.client.updateBio(bio);
			this.lastSyncedBioKey = key;
			console.info(`[bot] synced bio with word count: ${count}`);
		} catch (error) {
			console.warn("[bot] failed to sync bio", error);
		}
	}

	private async lastLearnedAt(): Promise<Date | null> {
		const result = await this.db.learnedPost.aggregate({
			_max: { learnedAt: true },
		});
		return result._max.learnedAt;
	}

	requestBioSync(): void {
		if (this.bioSyncTimer) {
			return;
		}
		// Debounce bio sync by 30 seconds to prevent rate-limiting Ciel API
		this.bioSyncTimer = setTimeout(() => {
			this.bioSyncTimer = undefined;
			void this.syncBio();
		}, 30_000);
	}

	async handlePost(post: Post): Promise<void> {
		if (post.deletedAt) {
			return;
		}
		if (isOwnPost(post, this.me.id)) {
			await this.learn(post);
			return;
		}

		// Check opt-out / opt-in commands
		const optCmd = parseOptCommand(post, this.me.username);
		if (optCmd === "opt_out") {
			await addBlacklist(this.db, post.author.id);
			try {
				await this.client.addReaction(post.id, "👍");
			} catch (e) {
				console.warn(`[bot] failed to add reaction to ${post.id}`, e);
			}
			console.info(
				`[bot] user @${post.author.username} (${post.author.id}) opted out of learning`,
			);
			return;
		}

		if (optCmd === "opt_in") {
			await removeBlacklist(this.db, post.author.id);
			try {
				await this.client.addReaction(post.id, "👍");
			} catch (e) {
				console.warn(`[bot] failed to add reaction to ${post.id}`, e);
			}
			console.info(
				`[bot] user @${post.author.username} (${post.author.id}) opted in to learning`,
			);
			return;
		}

		// Check if author is blacklisted
		const blacklisted = await isBlacklisted(this.db, post.author.id);
		if (!blacklisted) {
			await this.learn(post);
		}

		if (!isMentionForBot(post, this.me.username, this.wakeWords)) {
			return;
		}
		if (Math.random() >= this.replyRate) {
			console.info(`[bot] skipped reply to ${post.id} (replyRate)`);
			return;
		}
		await this.reply(post);
	}

	async learnOwnHistory(): Promise<void> {
		let cursor: string | null | undefined;
		do {
			const page = await this.client.userPosts(this.me.username, {
				limit: 100,
				cursor,
			});
			for (const post of [...page.items].reverse()) {
				if (!post.deletedAt && isOwnPost(post, this.me.id)) {
					await this.learn(post);
				}
			}
			cursor = page.nextCursor;
		} while (cursor);
	}

	private async learn(post: Post, ingestEdges = true): Promise<void> {
		// 文単位で形態素＋品詞に切り分けて学習する。文をまたぐエッジを作らないことで
		// 投稿の丸暗記を防ぎ、文節の繋ぎ変え (ランダマイズ) の材料を増やす。
		const sentences: Array<{
			tokens: string[];
			tags: PosTag[];
			skeleton: SkeletonCode[] | null;
		}> = [];
		if (ingestEdges) {
			for (const sentence of splitSentences(post.content)) {
				const detailed = (await tokenizeDetailed(sentence)).slice(
					0,
					MAX_LEARN_TOKENS,
				);
				if (detailed.length === 0) {
					continue;
				}
				sentences.push({
					tokens: detailed.map((token) => token.text),
					tags: detailed.map((token) => ({
						pos: token.pos,
						detail: token.detail,
						basicForm: token.basicForm,
						conjugation: token.conjugation,
					})),
					// 文の「形」も覚える (文型スロット充足生成の材料)
					skeleton: buildSkeleton(detailed),
				});
			}
		}
		const learned = await this.db.$transaction(async (tx) => {
			const inserted = await tx.learnedPost.createMany({
				data: [{ postId: post.id, authorId: post.author.id }],
				skipDuplicates: true,
			});
			if (inserted.count === 0) return false;
			for (const { tokens, tags, skeleton } of sentences) {
				await this.markov.persist(tx, tokens, post.author.id, tags);
				if (skeleton) {
					await this.markov.persistPattern(tx, skeleton);
				}
			}
			return true;
		});
		if (!learned) return;
		for (const { tokens, tags, skeleton } of sentences) {
			this.markov.ingest(tokens, post.author.id, tags);
			if (skeleton) {
				this.markov.ingestPattern(skeleton);
			}
		}
		this.requestBioSync();
	}

	async postSolo(): Promise<void> {
		if (Math.random() >= this.soloPostRate) {
			console.info("[bot] skipped solo post (soloPostRate)");
			return;
		}
		try {
			const speech = this.generateSpeech();
			const content = clipContent(speech.text);
			const post = await this.client.createPost({ content });
			await this.rememberOwnPost(post, speech.ok);
			console.info(`[bot] posted solo as ${post.id}: ${content}`);
		} catch (error) {
			console.error("[bot] failed to post solo", error);
		}
	}

	private async reply(post: Post): Promise<void> {
		if (this.inFlight.has(post.id)) {
			return;
		}
		const already = await this.db.repliedPost.findUnique({
			where: { postId: post.id },
		});
		if (already) {
			return;
		}

		this.inFlight.add(post.id);
		try {
			const seed = await tokenize(post.content);
			// 相手の文の長さに合わせて返信の長さを変える
			const targetTokens = Math.min(
				this.replyMaxTokens,
				Math.max(
					this.replyMinTokens,
					Math.round(seed.length * this.replyLengthFactor),
				),
			);
			const speech = this.generateSpeech(seed, targetTokens);
			// 長文目標では文字切り詰めの予算も広げる (目安: 1トークン4文字)
			const maxChars = Math.max(
				300,
				targetTokens * CHARS_PER_TOKEN + post.author.username.length + 2,
			);
			const content = buildReply(
				this.me.username,
				post.author.username,
				speech.text,
				maxChars,
			);
			await delay(400 + Math.floor(Math.random() * 1200));
			const reply = await this.client.createPost({
				content,
				parentId: post.id,
			});
			await this.db.repliedPost.createMany({
				data: [{ postId: post.id, replyId: reply.id }],
				skipDuplicates: true,
			});
			await this.rememberOwnPost(reply, speech.ok);
			console.info(`[bot] replied to ${post.id} as ${reply.id}: ${content}`);
		} catch (error) {
			console.error(`[bot] reply failed for ${post.id}`, error);
		} finally {
			this.inFlight.delete(post.id);
		}
	}

	/** 投稿してよい文か (「が…」「は、…」のような断片を弾く)。 */
	private isPostable(tokens: string[]): boolean {
		if (tokens.length === 0) {
			return false;
		}
		const first = tokens[0];
		const last = tokens.at(-1);
		if (!first || !last) {
			return false;
		}
		if (!this.markov.canStart(first) || !this.markov.isGoodStart(first)) {
			return false;
		}
		if (!this.markov.canEnd(last) || !this.markov.isGoodEnding(last)) {
			return false;
		}
		if (this.markov.isBannedSequence(tokens)) {
			return false;
		}
		// 自立語を1つも含まない発話 (「ております」など付属語の切り抜き) は出さない
		const hasContent = tokens.some((token) => {
			const tag = this.markov.dominantPosTag(token);
			if (!tag || tag.pos === "emoji" || tag.pos === "unknown") {
				return true;
			}
			return CONTENT_POS.has(tag.pos);
		});
		return hasContent;
	}

	/**
	 * 候補の評価値 (動詞ごとのシチュエーション評価の軽量版)。
	 * 自立語が多いほど・種文と語彙が重なるほど・目標長に近いほど高く、
	 * 複数候補から最良の1つを選ぶ。
	 */
	private scoreCandidate(
		tokens: string[],
		seed: string[],
		maxTokens?: number,
		fromPattern = false,
	): number {
		const seedSet = new Set(seed);
		let content = 0;
		let seedHits = 0;
		for (const token of tokens) {
			const tag = this.markov.dominantPosTag(token);
			if (!tag || tag.pos === "emoji" || tag.pos === "unknown") {
				content += 0.5;
			} else if (CONTENT_POS.has(tag.pos)) {
				content += 1;
			}
			if (seedSet.has(token)) {
				seedHits += 1;
			}
		}
		const lengthScore =
			maxTokens === undefined ? 0 : -(maxTokens - tokens.length) * 0.3;
		// 文型生成は文章の形が整っている分だけ優遇する
		const patternBonus = fromPattern ? 0.5 : 0;
		return content + seedHits * 1.5 + lengthScore + patternBonus;
	}

	private callGenerate(seed: string[], maxTokens?: number): string[] {
		// maxTokens 未指定時は従来通り2引数で呼び、呼び出し形を変えない
		if (maxTokens === undefined) {
			return this.markov.generate(seed, this.me.id);
		}
		return this.markov.generate(seed, this.me.id, maxTokens);
	}

	private tryGenerate(seed: string[], maxTokens?: number): string[] {
		const limits =
			maxTokens === undefined ? [undefined] : [maxTokens, undefined];
		for (const limit of limits) {
			if (limit !== undefined && limit !== maxTokens) {
				console.info(
					`[bot] targeted speech (${maxTokens} tokens) failed, retrying full length`,
				);
			}
			// 同じ長さ制限で複数候補を作り、評価値の最良を採用する。
			// 文型を学習済みなら文型スロット充足も1候補として加える
			// (連鎖3回の呼び出し回数は変えない)。
			let best: string[] = [];
			let bestScore = Number.NEGATIVE_INFINITY;
			const consider = (out: string[], fromPattern: boolean): void => {
				if (!this.isPostable(out)) {
					return;
				}
				const score = this.scoreCandidate(out, seed, maxTokens, fromPattern);
				if (score > bestScore) {
					best = out;
					bestScore = score;
				}
			};
			if (this.markov.patternCount > 0) {
				consider(this.markov.generateFromPattern(seed, limit), true);
			}
			for (let i = 0; i < 3; i += 1) {
				consider(this.callGenerate(seed, limit), false);
			}
			if (best.length > 0) {
				return best;
			}
		}
		return [];
	}

	private generateSpeech(
		seed: string[] = [],
		maxTokens?: number,
	): { text: string; ok: boolean } {
		const playful = Math.random() < SHORT_UTTERANCE_RATE;
		const generated = this.tryGenerate(seed, maxTokens);
		if (generated.length === 0) return { text: pickFallback(), ok: false };
		// 長文目標では短縮・見出し化の装飾をしない (長さを守る)
		if (!playful || isLongform(maxTokens)) {
			return { text: joinTokens(generated), ok: true };
		}

		const ending =
			PLAYFUL_ENDINGS[Math.floor(Math.random() * PLAYFUL_ENDINGS.length)] ??
			"。";
		if (ending === "、") {
			const head = generated[0] as string;
			// 「は、…」のように助詞を見出しにしない
			if (this.markov.canStart(head) && this.markov.isGoodStart(head)) {
				// 合計が maxTokens を超えないよう後半に残り予算を渡す
				const budget =
					maxTokens === undefined ? undefined : Math.max(1, maxTokens - 1);
				const continuation = this.callGenerate(seed, budget);
				if (
					continuation.length > 0 &&
					this.isPostable(continuation) &&
					(budget === undefined || continuation.length <= budget)
				) {
					return { text: `${head}、${joinTokens(continuation)}`, ok: true };
				}
			}
			return { text: joinTokens(generated), ok: true };
		}
		const spoken = this.markov.canEnd(generated[0] as string)
			? joinTokens([generated[0] as string])
			: joinTokens(generated);
		return { text: `${spoken}${ending}`, ok: true };
	}

	/**
	 * 自分の投稿を学習する。フォールバック (生成失敗時の定型文) は
	 * 語彙にしないが learned_posts に記録し、後からタイムライン経由で
	 * 再学習されるのも防ぐ。
	 */
	private async rememberOwnPost(post: Post, learned: boolean): Promise<void> {
		try {
			await this.learn(post, learned);
		} catch (error) {
			console.warn(`[bot] failed to learn own post ${post.id}`, error);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
