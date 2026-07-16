import { appendSignoff } from "./mbox.ts";

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
