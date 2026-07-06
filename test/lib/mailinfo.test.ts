import { describe, expect, test } from "bun:test";
import { formatPatchMessage } from "../../src/lib/patch/mbox.ts";
import { parseMail, splitMailbox } from "../../src/lib/patch/mailinfo.ts";
import type { Identity } from "../../src/lib/types.ts";

/**
 * Unit tests for the mbox reader (`git am`'s `mailsplit` + `mailinfo`). These
 * are the pure inverse of `format-patch`'s message writer, so the final block
 * round-trips a `formatPatchMessage` output back through `splitMailbox` +
 * `parseMail` and asserts every field survives.
 */

const DIFF = `diff --git a/f.txt b/f.txt
index 83db48f..d76b0c2 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 line1
-line2
+changed
 line3
+line4
`;

/** A minimal, well-formed single-patch mbox message. */
function message(
	opts: { subject?: string; body?: string; from?: string; date?: string } = {},
): string {
	const from = opts.from ?? "Ada <ada@example.com>";
	const date = opts.date ?? "Mon, 3 Jan 2000 04:05:06 +0000";
	const body = opts.body ? `${opts.body}\n` : "";
	return (
		`From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\n` +
		`From: ${from}\n` +
		`Date: ${date}\n` +
		`Subject: ${opts.subject ?? "[PATCH] do a thing"}\n` +
		`\n${body}---\n${DIFF}`
	);
}

describe("splitMailbox", () => {
	test("empty input yields no messages", () => {
		expect(splitMailbox("")).toEqual([]);
		expect(splitMailbox("   \n\n")).toEqual([]);
	});

	test("a bare, header-less patch is a single message", () => {
		const msgs = splitMailbox(DIFF);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toBe(DIFF);
	});

	test("splits a two-message mailbox on the `From <hex>` sentinel", () => {
		const combined = `${message({ subject: "[PATCH 1/2] one" })}\n${message({ subject: "[PATCH 2/2] two" })}`;
		const msgs = splitMailbox(combined);
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toContain("Subject: [PATCH 1/2] one");
		expect(msgs[1]).toContain("Subject: [PATCH 2/2] two");
		// Each keeps its verbatim `From ` separator (needed for --show-current-patch).
		expect(msgs[1]?.startsWith("From 1234567890")).toBe(true);
	});

	test("a `From ` line inside a diff body is not a record separator", () => {
		// A unified diff prefixes every content line, so a `From 09:...` line in
		// the patch text is `+From ...` / ` From ...` — not a bare `From `.
		const withFromInDiff = message({ subject: "[PATCH] add", body: "body" }).replace(
			"+line4\n",
			"+line4\n+From 12:34:56 2001 was here\n",
		);
		expect(splitMailbox(withFromInDiff)).toHaveLength(1);
	});
});

describe("parseMail — headers & subject", () => {
	test("extracts author, email, date, subject, and splits the diff", () => {
		const mail = parseMail(message({ subject: "[PATCH] add a line", body: "The body." }));
		expect(mail.author.name).toBe("Ada");
		expect(mail.author.email).toBe("ada@example.com");
		expect(mail.subject).toBe("add a line");
		expect(mail.body).toBe("The body.");
		expect(mail.patchText.startsWith("diff --git a/f.txt")).toBe(true);
		// Date parsed to an epoch + offset (2000-01-03T04:05:06Z).
		expect(mail.author.timestamp).toBe(946872306);
		expect(mail.author.timezone).toBe("+0000");
	});

	test("strips a bracket prefix and a leading Re: by default", () => {
		expect(parseMail(message({ subject: "[PATCH v3 2/5] Re: fix it" })).subject).toBe("fix it");
	});

	test("keep leaves the subject verbatim (whitespace collapsed)", () => {
		const mail = parseMail(message({ subject: "[PATCH] keep   me" }), { keep: true });
		expect(mail.subject).toBe("[PATCH] keep me");
	});

	test("decodes an RFC-2047 encoded-word subject and From name", () => {
		const raw =
			`From: =?UTF-8?q?T=C3=ABst=20=C3=9Cser?= <t@example.com>\n` +
			`Date: Mon, 3 Jan 2000 04:05:06 +0000\n` +
			`Subject: [PATCH] =?UTF-8?q?Caf=C3=A9=20subject?=\n` +
			`\n---\n${DIFF}`;
		const mail = parseMail(raw);
		expect(mail.author.name).toBe("Tëst Üser");
		expect(mail.subject).toBe("Café subject");
	});
});

describe("parseMail — body/diff boundary", () => {
	test("a message with no diff leaves patchText empty (git's 'Patch is empty')", () => {
		const raw =
			`From: Ada <ada@example.com>\nDate: Mon, 3 Jan 2000 04:05:06 +0000\n` +
			`Subject: [PATCH] just a message\n\nOnly prose, no diff.\n`;
		const mail = parseMail(raw);
		expect(mail.patchText).toBe("");
		expect(mail.body).toBe("Only prose, no diff.");
	});

	test("splits at a traditional `--- ` diff header (no `diff --git`)", () => {
		const raw =
			`From: Ada <ada@example.com>\nDate: Mon, 3 Jan 2000 04:05:06 +0000\n` +
			`Subject: [PATCH] trad\n\nbody\n\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n`;
		const mail = parseMail(raw);
		expect(mail.body).toBe("body");
		expect(mail.patchText.startsWith("--- a/f.txt")).toBe(true);
	});
});

describe("parseMail — in-body headers", () => {
	test("in-body From:/Subject:/Date: override the mail headers", () => {
		const raw =
			`From: Envelope <env@example.com>\nDate: Mon, 3 Jan 2000 04:05:06 +0000\n` +
			`Subject: [PATCH] envelope subject\n\n` +
			`From: Real Author <real@example.com>\nSubject: [PATCH] real subject\n` +
			`Date: Tue, 4 Jan 2000 05:06:07 +0000\n\nThe body.\n---\n${DIFF}`;
		const mail = parseMail(raw);
		expect(mail.author.name).toBe("Real Author");
		expect(mail.author.email).toBe("real@example.com");
		expect(mail.subject).toBe("real subject");
		expect(mail.body).toBe("The body.");
	});
});

describe("parseMail — scissors & keep-cr", () => {
	test("scissors drops everything at or above the cut line", () => {
		const raw =
			`From: Ada <ada@example.com>\nDate: Mon, 3 Jan 2000 04:05:06 +0000\n` +
			`Subject: [PATCH] scissored\n\n` +
			`chatter that should be dropped\n` +
			`-- >8 --\n` +
			`Subject: [PATCH] kept subject\n\nkept body\n---\n${DIFF}`;
		const mail = parseMail(raw, { scissors: true });
		expect(mail.subject).toBe("kept subject");
		expect(mail.body).toBe("kept body");
	});

	test("keep-cr retains interior CRs the default strips", () => {
		// The body's final line is trailing-trimmed regardless, so observe the
		// CR on an interior line: `first` keeps its CR only under keepCr.
		const raw =
			`From: Ada <ada@example.com>\nDate: Mon, 3 Jan 2000 04:05:06 +0000\n` +
			`Subject: [PATCH] crlf\n\nfirst\r\nsecond\r\n---\n${DIFF}`;
		expect(parseMail(raw).body).toBe("first\nsecond");
		expect(parseMail(raw, { keepCr: true }).body).toBe("first\r\nsecond");
	});
});

describe("round-trip: formatPatchMessage → splitMailbox → parseMail", () => {
	const author: Identity = {
		name: "Round Trip",
		email: "rt@example.com",
		timestamp: 1000000000,
		timezone: "+0000",
	};

	/** Build a real format-patch message, then read it back. */
	function roundTrip(subject: string, body: string, number: number | null, total: number) {
		const msg = formatPatchMessage({
			sha: "1234567890123456789012345678901234567890",
			author,
			prefix: "PATCH",
			number,
			total,
			subject,
			body,
			diffStat: " f.txt | 1 +\n 1 file changed, 1 insertion(+)\n",
			diff: DIFF,
			signature: "2.53.0",
		});
		const parts = splitMailbox(msg);
		expect(parts).toHaveLength(1);
		return parseMail(parts[0] as string);
	}

	test("subject, author, date, and diff survive a single-patch round trip", () => {
		const mail = roundTrip("Add a feature", "", null, 1);
		expect(mail.subject).toBe("Add a feature");
		expect(mail.author).toEqual(author);
		expect(mail.patchText.startsWith("diff --git a/f.txt")).toBe(true);
		expect(mail.body).toBe("");
	});

	test("a body and numbered prefix survive a series round trip", () => {
		const mail = roundTrip("Second patch", "Body paragraph.", 2, 3);
		expect(mail.subject).toBe("Second patch");
		expect(mail.body).toBe("Body paragraph.");
	});

	test("a non-ASCII subject survives via MIME encode/decode", () => {
		const mail = roundTrip("Café ☕ update", "Bödy.", 1, 1);
		expect(mail.subject).toBe("Café ☕ update");
		expect(mail.body).toBe("Bödy.");
	});
});
