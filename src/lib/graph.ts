/**
 * Text-based DAG rendering for `git log --graph`.
 *
 * Port of git's graph.c state machine. Produces line-by-line graph prefixes
 * that the caller interleaves with formatted commit content.
 *
 * API:
 *   const graph = new CommitGraph();
 *   for (const commit of commits) {
 *     graph.update(commit.hash, commit.parents);
 *     // call graph.nextLine() repeatedly; isCommitLine marks the * line
 *   }
 */

const enum State {
	PADDING,
	SKIP,
	PRE_COMMIT,
	COMMIT,
	POST_MERGE,
	COLLAPSING,
}

export class CommitGraph {
	private hash: string | null = null;
	private parents: string[] = [];
	private nParents = 0;

	private state: State = State.PADDING;
	private prevState: State = State.PADDING;

	private commitIdx = 0;
	private prevCommitIdx = 0;
	private mergeLayout = 0;
	private edgesAdded = 0;
	private prevEdgesAdded = 0;
	private w = 0;
	private expRow = 0;

	private cols: string[] = [];
	private nCols = 0;
	private newCols: string[] = [];
	private nNewCols = 0;

	private map: number[] = [];
	private oldMap: number[] = [];
	private mapSize = 0;

	get width(): number {
		return this.w;
	}

	update(hash: string, parents: string[]): void {
		this.hash = hash;
		this.parents = parents;
		this.nParents = parents.length;
		this.prevCommitIdx = this.commitIdx;

		this.updateColumns();
		this.expRow = 0;

		if (this.state !== State.PADDING) this.state = State.SKIP;
		else if (this.needsPreCommit()) this.state = State.PRE_COMMIT;
		else this.state = State.COMMIT;
	}

	nextLine(): { prefix: string; isCommitLine: boolean } {
		let line: string;
		let isCommit = false;

		switch (this.state) {
			case State.PADDING:
				line = this.outPadding();
				break;
			case State.SKIP:
				line = this.outSkip();
				break;
			case State.PRE_COMMIT:
				line = this.outPreCommit();
				break;
			case State.COMMIT:
				line = this.outCommit();
				isCommit = true;
				break;
			case State.POST_MERGE:
				line = this.outPostMerge();
				break;
			case State.COLLAPSING:
				line = this.outCollapsing();
				break;
		}

		return { prefix: pad(line, this.w), isCommitLine: isCommit };
	}

	isFinished(): boolean {
		return this.state === State.PADDING;
	}

	/**
	 * Produce a padding prefix for separator lines between commits.
	 * In COMMIT state (just after update), outputs column padding without
	 * consuming the commit line. Otherwise delegates to nextLine().
	 */
	paddingPrefix(): string {
		if (this.state !== State.COMMIT) {
			return this.nextLine().prefix;
		}
		let line = "";
		for (let i = 0; i < this.nCols; i++) {
			line += "| ";
		}
		this.prevState = State.PADDING;
		return pad(line, this.w);
	}

	// ── Column update ────────────────────────────────────────────

	private updateColumns(): void {
		const prevNew = this.newCols;
		const prevNNew = this.nNewCols;
		this.newCols = this.cols;
		this.nNewCols = 0;
		this.cols = prevNew;
		this.nCols = prevNNew;

		const maxNew = this.nCols + this.nParents;
		if (this.map.length < 2 * maxNew) {
			this.map = new Array(2 * maxNew);
			this.oldMap = new Array(2 * maxNew);
		}
		this.mapSize = 2 * maxNew;
		this.map.fill(-1, 0, this.mapSize);

		this.w = 0;
		this.prevEdgesAdded = this.edgesAdded;
		this.edgesAdded = 0;

		let seenThis = false;

		for (let i = 0; i <= this.nCols; i++) {
			let colHash: string;
			if (i === this.nCols) {
				if (seenThis) break;
				colHash = this.hash!;
			} else {
				colHash = this.cols[i]!;
			}

			if (colHash === this.hash) {
				seenThis = true;
				this.commitIdx = i;
				this.mergeLayout = -1;

				for (const ph of this.parents) {
					this.insertNewCol(ph, i);
				}
				if (this.nParents === 0) this.w += 2;
			} else {
				this.insertNewCol(colHash, -1);
			}
		}

		while (this.mapSize > 1 && this.map[this.mapSize - 1]! < 0) {
			this.mapSize--;
		}
	}

	private findNewCol(hash: string): number {
		for (let i = 0; i < this.nNewCols; i++) {
			if (this.newCols[i] === hash) return i;
		}
		return -1;
	}

	private insertNewCol(hash: string, idx: number): void {
		let i = this.findNewCol(hash);
		if (i < 0) {
			i = this.nNewCols++;
			this.newCols[i] = hash;
		}

		let mi: number;

		if (this.nParents > 1 && idx > -1 && this.mergeLayout === -1) {
			const dist = idx - i;
			const shift = dist > 1 ? 2 * dist - 3 : 1;

			this.mergeLayout = dist > 0 ? 0 : 1;
			this.edgesAdded = this.nParents + this.mergeLayout - 2;

			mi = this.w + (this.mergeLayout - 1) * shift;
			this.w += 2 * this.mergeLayout;
		} else if (this.edgesAdded > 0 && this.w >= 2 && i === this.map[this.w - 2]) {
			mi = this.w - 2;
			this.edgesAdded = -1;
		} else {
			mi = this.w;
			this.w += 2;
		}

		this.map[mi] = i;
	}

	// ── State helpers ────────────────────────────────────────────

	private setState(s: State): void {
		this.prevState = this.state;
		this.state = s;
	}

	private numDashedParents(): number {
		return this.nParents + this.mergeLayout - 3;
	}

	private numExpansionRows(): number {
		return this.numDashedParents() * 2;
	}

	private needsPreCommit(): boolean {
		return (
			this.nParents >= 3 && this.commitIdx < this.nCols - 1 && this.expRow < this.numExpansionRows()
		);
	}

	private isMappingCorrect(): boolean {
		for (let i = 0; i < this.mapSize; i++) {
			const t = this.map[i]!;
			if (t < 0) continue;
			if (t === i >> 1) continue;
			return false;
		}
		return true;
	}

	// ── Output functions ─────────────────────────────────────────

	private outPadding(): string {
		let line = "";
		for (let i = 0; i < this.nNewCols; i++) {
			line += "| ";
		}
		return line;
	}

	private outSkip(): string {
		if (this.needsPreCommit()) this.setState(State.PRE_COMMIT);
		else this.setState(State.COMMIT);
		return "...";
	}

	private outPreCommit(): string {
		let line = "";
		let seenThis = false;

		for (let i = 0; i < this.nCols; i++) {
			const isThis = this.cols[i] === this.hash;
			if (isThis) {
				seenThis = true;
				line += "|";
				line += " ".repeat(this.expRow);
			} else if (seenThis && this.expRow === 0) {
				if (this.prevState === State.POST_MERGE && this.prevCommitIdx < i) line += "\\";
				else line += "|";
			} else if (seenThis) {
				line += "\\";
			} else {
				line += "|";
			}
			line += " ";
		}

		this.expRow++;
		if (!this.needsPreCommit()) this.setState(State.COMMIT);

		return line;
	}

	private outCommit(): string {
		let line = "";
		let seenThis = false;

		for (let i = 0; i <= this.nCols; i++) {
			let colHash: string;
			if (i === this.nCols) {
				if (seenThis) break;
				colHash = this.hash!;
			} else {
				colHash = this.cols[i]!;
			}

			if (colHash === this.hash) {
				seenThis = true;
				line += "*";
				if (this.nParents > 2) line += this.drawOctopus();
			} else if (seenThis && this.edgesAdded > 1) {
				line += "\\";
			} else if (seenThis && this.edgesAdded === 1) {
				if (
					this.prevState === State.POST_MERGE &&
					this.prevEdgesAdded > 0 &&
					this.prevCommitIdx < i
				)
					line += "\\";
				else line += "|";
			} else if (
				this.prevState === State.COLLAPSING &&
				this.oldMap[2 * i + 1] === i &&
				this.map[2 * i]! < i
			) {
				line += "/";
			} else {
				line += "|";
			}
			line += " ";
		}

		if (this.nParents > 1) this.setState(State.POST_MERGE);
		else if (this.isMappingCorrect()) this.setState(State.PADDING);
		else this.setState(State.COLLAPSING);

		return line;
	}

	private drawOctopus(): string {
		const n = this.numDashedParents();
		let s = "";
		for (let i = 0; i < n; i++) {
			s += "-";
			s += i === n - 1 ? "." : "-";
		}
		return s;
	}

	private outPostMerge(): string {
		const MERGE_CHARS = ["/", "|", "\\"] as const;
		let line = "";
		let seenThis = false;
		let parentColIdx = -1;

		for (let i = 0; i <= this.nCols; i++) {
			let colHash: string;
			if (i === this.nCols) {
				if (seenThis) break;
				colHash = this.hash!;
			} else {
				colHash = this.cols[i]!;
			}

			if (colHash === this.hash) {
				seenThis = true;
				let idx = this.mergeLayout;
				for (let j = 0; j < this.nParents; j++) {
					line += MERGE_CHARS[idx]!;
					if (idx === 2) {
						if (this.edgesAdded > 0 || j < this.nParents - 1) line += " ";
					} else {
						idx++;
					}
				}
				if (this.edgesAdded === 0) line += " ";
			} else if (seenThis) {
				if (this.edgesAdded > 0) line += "\\";
				else line += "|";
				line += " ";
			} else {
				line += "|";
				if (this.mergeLayout !== 0 || i !== this.commitIdx - 1) {
					if (parentColIdx >= 0) line += "_";
					else line += " ";
				}
			}

			if (colHash === this.parents[0]) parentColIdx = i;
		}

		if (this.isMappingCorrect()) this.setState(State.PADDING);
		else this.setState(State.COLLAPSING);

		return line;
	}

	private outCollapsing(): string {
		// Swap mapping <-> oldMapping
		const tmp = this.map;
		this.map = this.oldMap;
		this.oldMap = tmp;

		this.map.fill(-1, 0, this.mapSize);

		let horizEdge = -1;
		let horizTarget = -1;

		for (let i = 0; i < this.mapSize; i++) {
			const target = this.oldMap[i]!;
			if (target < 0) continue;

			if (target * 2 === i) {
				this.map[i] = target;
			} else if (this.map[i - 1]! < 0) {
				this.map[i - 1] = target;
				if (horizEdge === -1) {
					horizEdge = i;
					horizTarget = target;
					for (let j = target * 2 + 3; j < i - 2; j += 2) {
						this.map[j] = target;
					}
				}
			} else if (this.map[i - 1] === target) {
				// merge with existing line heading to same target
			} else {
				this.map[i - 2] = target;
				if (horizEdge === -1) {
					horizTarget = target;
					horizEdge = i - 1;
					for (let j = target * 2 + 3; j < i - 2; j += 2) {
						this.map[j] = target;
					}
				}
			}
		}

		// Save mapping state for next iteration
		for (let i = 0; i < this.mapSize; i++) {
			this.oldMap[i] = this.map[i]!;
		}

		if (this.mapSize > 0 && this.map[this.mapSize - 1]! < 0) {
			this.mapSize--;
		}

		// Render
		let line = "";
		let usedHoriz = false;

		for (let i = 0; i < this.mapSize; i++) {
			const target = this.map[i]!;
			if (target < 0) {
				line += " ";
			} else if (target * 2 === i) {
				line += "|";
			} else if (target === horizTarget && i !== horizEdge - 1) {
				if (i !== target * 2 + 3) this.map[i] = -1;
				usedHoriz = true;
				line += "_";
			} else {
				if (usedHoriz && i < horizEdge) this.map[i] = -1;
				line += "/";
			}
		}

		if (this.isMappingCorrect()) this.setState(State.PADDING);

		return line;
	}
}

function pad(line: string, width: number): string {
	if (line.length >= width) return line;
	return line + " ".repeat(width - line.length);
}
