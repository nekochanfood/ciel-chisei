import { loadDefaultJapaneseParser } from "budoux";
import * as mfm from "mfm-js";

export const BOS = "<BOS>";
export const EOS = "<EOS>";

const parser = loadDefaultJapaneseParser();

export async function loadTokenizer(): Promise<void> {
	// budoux is lightweight and ready immediately
}

type MfmSegment =
	| { type: "text"; text: string }
	| { type: "custom_emoji"; emoji: string };

const CUSTOM_EMOJI_REGEX = /:[a-zA-Z0-9_+-]+:/g;

export function extractMfmSegments(content: string): MfmSegment[] {
	let nodes: mfm.MfmNode[];
	try {
		nodes = mfm.parse(content);
	} catch {
		return [{ type: "text", text: content }];
	}

	const segments: MfmSegment[] = [];

	function walk(nodeList: mfm.MfmNode[]): void {
		for (const node of nodeList) {
			switch (node.type) {
				case "text":
					segments.push({ type: "text", text: node.props.text });
					break;
				case "unicodeEmoji":
					segments.push({ type: "text", text: node.props.emoji });
					break;
				case "emojiCode":
					segments.push({
						type: "custom_emoji",
						emoji: `:${node.props.name}:`,
					});
					break;
				case "bold":
				case "italic":
				case "strike":
				case "small":
				case "fn":
				case "quote":
				case "plain":
				case "link":
					if (node.children) {
						walk(node.children);
					}
					break;
				case "mention":
				case "url":
				case "blockCode":
				case "inlineCode":
				case "mathInline":
				case "mathBlock":
				case "search":
					// Ignore non-natural text
					break;
				default:
					if (
						"children" in node &&
						Array.isArray((node as { children?: mfm.MfmNode[] }).children)
					) {
						walk((node as { children: mfm.MfmNode[] }).children);
					}
					break;
			}
		}
	}

	walk(nodes);
	return segments;
}

function cleanPlainText(text: string): string {
	return text
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/@[a-zA-Z0-9_]{3,32}/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export async function tokenize(text: string): Promise<string[]> {
	const segments = extractMfmSegments(text);
	if (segments.length === 0) {
		return [];
	}

	const allTokens: string[] = [];

	for (const segment of segments) {
		if (segment.type === "custom_emoji") {
			allTokens.push(segment.emoji);
			continue;
		}

		const cleaned = cleanPlainText(segment.text);
		if (!cleaned) {
			continue;
		}

		let lastIndex = 0;
		for (const match of cleaned.matchAll(CUSTOM_EMOJI_REGEX)) {
			const matchIndex = match.index ?? 0;
			const before = cleaned.slice(lastIndex, matchIndex).trim();
			if (before) {
				const chunks = parser
					.parse(before)
					.map((s) => s.trim())
					.filter((s) => s.length > 0 && s !== BOS && s !== EOS);
				allTokens.push(...chunks);
			}
			allTokens.push(match[0]);
			lastIndex = matchIndex + match[0].length;
		}

		const after = cleaned.slice(lastIndex).trim();
		if (after) {
			const chunks = parser
				.parse(after)
				.map((s) => s.trim())
				.filter((s) => s.length > 0 && s !== BOS && s !== EOS);
			allTokens.push(...chunks);
		}
	}

	return allTokens;
}

export function joinTokens(tokens: string[]): string {
	let out = "";
	for (const token of tokens) {
		if (token === BOS || token === EOS) {
			continue;
		}
		if (!out) {
			out = token;
			continue;
		}
		const prev = out[out.length - 1] ?? "";
		const needsSpace =
			/[A-Za-z0-9]$/.test(prev) && /[A-Za-z0-9]/.test(token[0] ?? "");
		out += needsSpace ? ` ${token}` : token;
	}
	return out.trim();
}
