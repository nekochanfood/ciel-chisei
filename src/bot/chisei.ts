import type { CielClient, Post, User } from "../ciel/client.js";
import {
	addBlacklist,
	type Db,
	isBlacklisted,
	removeBlacklist,
} from "../db.js";
import type { MarkovModel } from "./markov.js";
import {
	buildReply,
	clipContent,
	formatBio,
	isMentionForBot,
	isOwnPost,
	parseOptCommand,
	pickFallback,
} from "./text.js";
import { joinTokens, tokenize } from "./tokenizer.js";

const SHORT_UTTERANCE_RATE = 0.3;
const PLAYFUL_ENDINGS = ["!", "...", "?", "。", "、"] as const;

export class ChiseiBot {
	private readonly inFlight = new Set<string>();
	private lastSyncedBioKey = "";
	private bioSyncTimer?: NodeJS.Timeout;

	constructor(
		private readonly db: Db,
		private readonly client: CielClient,
		private readonly me: User,
		private readonly markov: MarkovModel,
		private readonly wakeWords: string[],
	) {}

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

	private async learn(post: Post): Promise<void> {
		const tokens = await tokenize(post.content);
		const learned = await this.db.$transaction(async (tx) => {
			const inserted = await tx.learnedPost.createMany({
				data: [{ postId: post.id, authorId: post.author.id }],
				skipDuplicates: true,
			});
			if (inserted.count === 0) return false;
			await this.markov.persist(tx, tokens, post.author.id);
			return true;
		});
		if (!learned) return;
		this.markov.ingest(tokens, post.author.id);
		this.requestBioSync();
	}

	async postSolo(): Promise<void> {
		try {
			const content = clipContent(this.generateSpeech());
			const post = await this.client.createPost({ content });
			await this.rememberOwnPost(post);
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
			const body = this.generateSpeech(seed);
			const content = buildReply(this.me.username, post.author.username, body);
			await delay(400 + Math.floor(Math.random() * 1200));
			const reply = await this.client.createPost({
				content,
				parentId: post.id,
			});
			await this.db.repliedPost.createMany({
				data: [{ postId: post.id, replyId: reply.id }],
				skipDuplicates: true,
			});
			await this.rememberOwnPost(reply);
			console.info(`[bot] replied to ${post.id} as ${reply.id}: ${content}`);
		} catch (error) {
			console.error(`[bot] reply failed for ${post.id}`, error);
		} finally {
			this.inFlight.delete(post.id);
		}
	}

	private generateSpeech(seed: string[] = []): string {
		const playful = Math.random() < SHORT_UTTERANCE_RATE;
		const generated = this.markov.generate(seed, this.me.id);
		if (generated.length === 0) return pickFallback();
		if (!playful) return joinTokens(generated);

		const ending =
			PLAYFUL_ENDINGS[Math.floor(Math.random() * PLAYFUL_ENDINGS.length)] ??
			"。";
		if (ending === "、") {
			const continuation = this.markov.generate(seed, this.me.id);
			return `${joinTokens([generated[0] as string])}、${
				continuation.length > 0 ? joinTokens(continuation) : pickFallback()
			}`;
		}
		const spoken = this.markov.canEnd(generated[0] as string)
			? joinTokens([generated[0] as string])
			: joinTokens(generated);
		return `${spoken}${ending}`;
	}

	private async rememberOwnPost(post: Post): Promise<void> {
		try {
			await this.learn(post);
		} catch (error) {
			console.warn(`[bot] failed to learn own post ${post.id}`, error);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
