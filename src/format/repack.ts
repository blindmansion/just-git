export function formatRepackStderr(
	totalCount: number,
	deltaCount: number,
	includeCounting = false,
): string {
	const compressedCount = totalCount - deltaCount;
	const lines = [`Enumerating objects: ${totalCount}, done.`];
	if (includeCounting) {
		lines.push(`Counting objects: 100% (${totalCount}/${totalCount}), done.`);
	}
	lines.push(
		"Delta compression using 1 thread.",
		`Compressing objects: 100% (${compressedCount}/${totalCount}), done.`,
		`Writing objects: 100% (${totalCount}/${totalCount}), done.`,
		`Total ${totalCount} (delta ${deltaCount}), reused 0 (delta 0), pack-reused 0`,
	);
	return lines.join("\n");
}
