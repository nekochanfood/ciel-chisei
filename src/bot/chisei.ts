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

export class ChiseiBot {
	private readonly inFlight = new Set<string>();
	private lastSyncedEdgeCount = -1;
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
			if (count === this.lastSyncedEdgeCount) {
				return;
			}
			const bio = formatBio(count);
			await this.client.updateBio(bio);
			this.lastSyncedEdgeCount = count;
			console.info(`[bot] synced bio with word count: ${count}`);
		} catch (error) {
			console.warn("[bot] failed to sync bio", error);
		}
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
		if (post.deletedAt || isOwnPost(post, this.me.id)) {
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
			const generated = this.markov.generate();
			const body =
				generated.length > 0 ? joinTokens(generated) : pickFallback();
			const content = clipContent(body);
			const post = await this.client.createPost({ content });
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
			const generated = this.markov.generate(seed, post.author.id);
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
			console.info(`[bot] replied to ${post.id} as ${reply.id}: ${content}`);
		} catch (error) {
			console.error(`[bot] reply failed for ${post.id}`, error);
		} finally {
			this.inFlight.delete(post.id);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
