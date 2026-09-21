import type { CielClient, Post, User } from "../ciel/client.js";
import {
	addBlacklist,
	isBlacklisted,
	removeBlacklist,
	type Sql,
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

export class ChiseiBot {
	private readonly inFlight = new Set<string>();
	private lastSyncedBioKey = "";
	private bioSyncTimer?: NodeJS.Timeout;

	constructor(
		private readonly sql: Sql,
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
		const rows = await this.sql<{ last_learned_at: unknown }[]>`
      SELECT MAX(learned_at) AS last_learned_at FROM learned_posts
    `;
		const raw = rows[0]?.last_learned_at;
		if (raw instanceof Date && !Number.isNaN(+raw)) {
			return raw;
		}
		if (typeof raw === "string" && raw.length > 0) {
			const parsed = new Date(raw);
			if (!Number.isNaN(+parsed)) {
				return parsed;
			}
		}
		return null;
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
			await addBlacklist(this.sql, post.author.id);
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
			await removeBlacklist(this.sql, post.author.id);
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
		const blacklisted = await isBlacklisted(this.sql, post.author.id);
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
		const inserted = await this.sql<{ post_id: string }[]>`
      INSERT INTO learned_posts (post_id, author_id)
      VALUES (${post.id}, ${post.author.id})
      ON CONFLICT (post_id) DO NOTHING
      RETURNING post_id
    `;
		if (inserted.length === 0) {
			return;
		}
		const tokens = await tokenize(post.content);
		await this.markov.learn(this.sql, tokens, post.author.id);
		this.requestBioSync();
	}

	async postSolo(): Promise<void> {
		try {
			const generated = this.generateSpeech();
			const body =
				generated.length > 0 ? joinTokens(generated) : pickFallback();
			const content = clipContent(body);
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
		const already = await this.sql<{ post_id: string }[]>`
      SELECT post_id FROM replied_posts WHERE post_id = ${post.id}
    `;
		if (already.length > 0) {
			return;
		}

		this.inFlight.add(post.id);
		try {
			const seed = await tokenize(post.content);
			const generated = this.generateSpeech(seed);
			const body =
				generated.length > 0 ? joinTokens(generated) : pickFallback();
			const content = buildReply(this.me.username, post.author.username, body);
			await delay(400 + Math.floor(Math.random() * 1200));
			const reply = await this.client.createPost({
				content,
				parentId: post.id,
			});
			await this.sql`
        INSERT INTO replied_posts (post_id, reply_id)
        VALUES (${post.id}, ${reply.id})
        ON CONFLICT (post_id) DO NOTHING
      `;
			await this.rememberOwnPost(reply);
			console.info(`[bot] replied to ${post.id} as ${reply.id}: ${content}`);
		} catch (error) {
			console.error(`[bot] reply failed for ${post.id}`, error);
		} finally {
			this.inFlight.delete(post.id);
		}
	}

	private generateSpeech(seed: string[] = []): string[] {
		const maxTokens = Math.random() < SHORT_UTTERANCE_RATE ? 1 : undefined;
		return this.markov.generate(seed, this.me.id, maxTokens);
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
