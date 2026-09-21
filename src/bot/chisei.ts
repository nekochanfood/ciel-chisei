import type { CielClient, Post, User } from "../ciel/client.js";
import {
	addBlacklist,
	type Db,
	isBlacklisted,
	removeBlacklist,
} from "../db.js";
import {
	extractSentenceStats,
	type LanguageModel,
	type SentenceStats,
} from "./language.js";
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
	type DetailedToken,
	splitSentences,
	tokenizeDetailed,
} from "./tokenizer.js";

const MAX_LEARN_TOKENS = 200;

export type ChiseiBotOptions = {
	replyRate?: number;
	soloPostRate?: number;
	replyLengthFactor?: number;
	replyMinTokens?: number;
	replyMaxTokens?: number;
};

export class ChiseiBot {
	private readonly inFlight = new Set<string>();
	private learning = Promise.resolve();
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
		private readonly language: LanguageModel,
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
			const count = this.language.vocabularySize;
			const lastLearnedAt = await this.lastLearnedAt();
			const key = `${count}|${lastLearnedAt?.toISOString() ?? "-"}`;
			if (key === this.lastSyncedBioKey) return;
			await this.client.updateBio(formatBio(count, lastLearnedAt));
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
		if (this.bioSyncTimer) return;
		this.bioSyncTimer = setTimeout(() => {
			this.bioSyncTimer = undefined;
			void this.syncBio();
		}, 30_000);
	}

	async handlePost(post: Post): Promise<void> {
		if (post.deletedAt) return;
		if (isOwnPost(post, this.me.id)) {
			await this.learn(post);
			return;
		}

		const optCmd = parseOptCommand(post, this.me.username);
		if (optCmd) {
			if (optCmd === "opt_out") await addBlacklist(this.db, post.author.id);
			else await removeBlacklist(this.db, post.author.id);
			try {
				await this.client.addReaction(post.id, "👍");
			} catch (error) {
				console.warn(`[bot] failed to add reaction to ${post.id}`, error);
			}
			console.info(`[bot] user @${post.author.username} ${optCmd}`);
			return;
		}

		if (!(await isBlacklisted(this.db, post.author.id))) await this.learn(post);
		if (!isMentionForBot(post, this.me.username, this.wakeWords)) return;
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
				if (!post.deletedAt && isOwnPost(post, this.me.id))
					await this.learn(post);
			}
			cursor = page.nextCursor;
		} while (cursor);
	}

	private async learn(post: Post, ingest = true): Promise<void> {
		const task = this.learning.then(() => this.learnNow(post, ingest));
		this.learning = task.catch(() => undefined);
		return task;
	}

	private async learnNow(post: Post, ingest: boolean): Promise<void> {
		const sentences: Array<{ tokens: DetailedToken[]; stats: SentenceStats }> =
			[];
		if (ingest) {
			for (const raw of splitSentences(post.content)) {
				const tokens = (await tokenizeDetailed(raw)).slice(0, MAX_LEARN_TOKENS);
				const stats = extractSentenceStats(raw, tokens, Boolean(post.parentId));
				if (tokens.length === 0 && stats.decoration === "none") continue;
				sentences.push({
					tokens,
					stats,
				});
			}
		}
		const nextState = this.language.nextState(
			sentences.map(({ stats }) => stats),
		);
		const learned = await this.db.$transaction(async (tx) => {
			const inserted = await tx.learnedPost.createMany({
				data: [{ postId: post.id, authorId: post.author.id }],
				skipDuplicates: true,
			});
			if (inserted.count === 0) return false;
			if (sentences.length > 0) {
				await this.language.persistBatch(
					tx,
					post.id,
					post.author.id,
					sentences,
					nextState,
				);
			}
			return true;
		});
		if (!learned) return;
		if (sentences.length > 0) {
			this.language.commitBatch(
				sentences.map(({ tokens }) => tokens),
				nextState,
			);
		}
		this.requestBioSync();
	}

	async postSolo(): Promise<void> {
		if (Math.random() >= this.soloPostRate) {
			console.info("[bot] skipped solo post (soloPostRate)");
			return;
		}
		try {
			const speech = this.generateSpeech(
				extractSentenceStats("", [], false),
				[],
			);
			const content = clipContent(speech.text);
			const post = await this.client.createPost({ content });
			await this.rememberOwnPost(post, speech.ok);
			console.info(`[bot] posted solo as ${post.id}: ${content}`);
		} catch (error) {
			console.error("[bot] failed to post solo", error);
		}
	}

	private async reply(post: Post): Promise<void> {
		if (this.inFlight.has(post.id)) return;
		if (await this.db.repliedPost.findUnique({ where: { postId: post.id } }))
			return;
		this.inFlight.add(post.id);
		try {
			const seed = await tokenizeDetailed(post.content);
			const targetTokens = Math.min(
				this.replyMaxTokens,
				Math.max(
					this.replyMinTokens,
					Math.round(seed.length * this.replyLengthFactor),
				),
			);
			const speech = this.generateSpeech(
				extractSentenceStats(post.content, seed, true),
				seed,
				targetTokens,
			);
			const content = buildReply(
				this.me.username,
				post.author.username,
				speech.text,
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

	private generateSpeech(
		stats: SentenceStats,
		seed: DetailedToken[],
		targetTokens?: number,
	): { text: string; ok: boolean } {
		const generated = this.language.generate(stats, seed, targetTokens);
		return generated
			? { text: generated, ok: true }
			: { text: pickFallback(), ok: false };
	}

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
