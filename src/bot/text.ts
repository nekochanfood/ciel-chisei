export type MentionLike = {
	username: string;
};

export type PostLike = {
	id: string;
	content: string;
	author: { id: string; username: string };
	mentions?: MentionLike[] | null;
	deletedAt?: string | null;
};

export const FALLBACKS = [
	"……",
	"なにそれ",
	"もぐもぐ",
	"ふうん",
	"わかんない",
	"へー",
	"そうなの",
];

export function isOwnPost(post: PostLike, meId: string): boolean {
	return post.author.id === meId;
}

export function isMentionForBot(
	post: PostLike,
	botUsername: string,
	wakeWords: string[] = [],
): boolean {
	const username = botUsername.toLowerCase();
	if (
		post.mentions?.some(
			(mention) => mention.username.toLowerCase() === username,
		)
	) {
		return true;
	}
	const mentionPattern = new RegExp(
		`(^|[^a-zA-Z0-9_])@${escapeRegExp(botUsername)}\\b`,
		"i",
	);
	if (mentionPattern.test(post.content)) {
		return true;
	}
	return wakeWords.some((word) => word && post.content.includes(word));
}

export type OptCommand = "opt_out" | "opt_in";

export function parseOptCommand(
	post: PostLike,
	botUsername: string,
): OptCommand | null {
	const username = botUsername.toLowerCase();
	const hasStructuredMention = post.mentions?.some(
		(mention) => mention.username.toLowerCase() === username,
	);
	const mentionPattern = new RegExp(
		`(^|[^a-zA-Z0-9_])@${escapeRegExp(botUsername)}\\b`,
		"i",
	);
	const hasTextMention = mentionPattern.test(post.content);

	if (!hasStructuredMention && !hasTextMention) {
		return null;
	}

	const textWithoutMentions = post.content
		.replace(
			new RegExp(`(^|[^a-zA-Z0-9_])@${escapeRegExp(botUsername)}\\b`, "gi"),
			" ",
		)
		.replace(/@[a-zA-Z0-9_]{3,32}/g, " ")
		.trim();

	if (
		/^(?:学習禁止|学習拒否|オプトアウト)[\s!！。.]*$/i.test(textWithoutMentions)
	) {
		return "opt_out";
	}
	if (
		/^(?:学習許可|学習再開|オプトイン)[\s!！。.]*$/i.test(textWithoutMentions)
	) {
		return "opt_in";
	}

	return null;
}

export function clipContent(text: string, max = 300): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max - 1)}…`;
}

export function buildReply(
	botUsername: string,
	targetUsername: string,
	body: string,
): string {
	const mention = `@${targetUsername}`;
	const cleaned = body
		.replace(new RegExp(`@${escapeRegExp(botUsername)}`, "gi"), "")
		.trim();
	const spoken = cleaned.length > 0 ? cleaned : pickFallback();
	const withMention = spoken.startsWith(mention)
		? spoken
		: `${mention} ${spoken}`;
	return clipContent(withMention);
}

export function pickFallback(): string {
	return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)] ?? "……";
}

export function formatBio(wordCount: number, updatedAt?: Date | null): string {
	const base = `タイムラインに流れたテキストを学習して言葉を覚えます。

覚えた言葉: ${wordCount}`;
	const stamp = updatedAt ? `\n(最終更新: ${formatTimestamp(updatedAt)})` : "";
	return `${base}${stamp}

学習されるかどうかはオプトアウト式になっており、"(メンション) 学習禁止"でブラックリスト登録、"(メンション) 学習許可"でブラックリストから除外されます。`;
}

/** Format as `YYYY/MM/DD HH:mm:ss` in Asia/Tokyo. */
export function formatTimestamp(date: Date): string {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	})
		.format(date)
		.replaceAll("-", "/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
