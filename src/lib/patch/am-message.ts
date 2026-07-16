import { appendSignoff } from "./mbox.ts";
import { parseMail, type MailInfoOptions, type ParsedMail } from "./mailinfo.ts";
import { ApplyParseError, parsePatch, type ParsedPatch } from "./parse-patch.ts";

/**
 * Assemble the commit message for one mailbox entry.
 *
 * The subject is always the first line. A non-empty body is separated by one
 * blank line, and every result ends in a newline. When `signoffLine` is set,
 * trailer-aware placement is delegated to {@link appendSignoff}.
 */
export function buildAmMessage(
	subject: string,
	body: string,
	signoffLine: string | null = null,
): string {
	const finalBody = signoffLine ? appendSignoff(subject, body, signoffLine) : body;
	return finalBody === "" ? `${subject}\n` : `${subject}\n\n${finalBody}\n`;
}

/** Inputs shared by the CLI and repo `am` per-message preparation step. */
export interface PrepareAmMessageOptions extends MailInfoOptions {
	/** Fully formatted `Signed-off-by:` line, or `null` when signoff is disabled. */
	signoffLine?: string | null;
}

/** A mailbox message ready for an apply engine. */
export interface PreparedAmMessage {
	mail: ParsedMail;
	message: string;
	patches: ParsedPatch[];
}

/** Pure per-message result shared by both `am` orchestration shells. */
export type PrepareAmMessageResult =
	| { status: "ready"; prepared: PreparedAmMessage }
	| { status: "empty"; mail: ParsedMail; message: string }
	| {
			status: "parse-error";
			mail: ParsedMail;
			message: string;
			line: number;
			errorMessage: string;
	  };

/**
 * Parse one mailbox entry, assemble its commit message, and parse its patch.
 *
 * This centralizes the business-rule ordering shared by the persisted CLI
 * driver and the stateless repo driver while leaving their stop representation
 * and I/O effects in their respective shells.
 */
export function prepareAmMessage(
	raw: string,
	options: PrepareAmMessageOptions = {},
): PrepareAmMessageResult {
	const mail = parseMail(raw, options);
	const message = buildAmMessage(mail.subject, mail.body, options.signoffLine ?? null);

	if (mail.patchText.trim() === "") return { status: "empty", mail, message };

	try {
		return {
			status: "ready",
			prepared: { mail, message, patches: parsePatch(mail.patchText) },
		};
	} catch (error) {
		if (error instanceof ApplyParseError) {
			return {
				status: "parse-error",
				mail,
				message,
				line: error.line,
				errorMessage: error.message,
			};
		}
		throw error;
	}
}

/**
 * Git skips a no-op `am` message only after the three-way fallback path.
 * A plain apply that happens to reproduce the current tree still creates a
 * commit, matching `git am`.
 */
export function shouldSkipAmCommit(usedThreeWay: boolean, resultTreeEqualsHead: boolean): boolean {
	return usedThreeWay && resultTreeEqualsHead;
}
