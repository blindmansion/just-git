import type { Action } from "../types";
import { BRANCH_ACTIONS } from "./branch";
import { CHERRY_PICK_ACTIONS } from "./cherry-pick";
import { CLEAN_ACTIONS } from "./clean";
import { COMMIT_ACTIONS } from "./commit";
import { CONFLICT_ACTIONS } from "./conflict";
import { DIAGNOSTIC_ACTIONS } from "./diagnostic";
import { FILE_OPS_ACTIONS } from "./file-ops";
import { MAINTENANCE_ACTIONS } from "./maintenance";
import { MERGE_ACTIONS } from "./merge";
import { NETWORK_ACTIONS } from "./network";
import { REBASE_ACTIONS } from "./rebase";
import { REMOTE_ACTIONS } from "./remote";
import { RESET_ACTIONS } from "./reset";
import { RESTORE_ACTIONS } from "./restore";
import { REVERT_ACTIONS } from "./revert";
import { STAGING_ACTIONS } from "./staging";
import { STASH_ACTIONS } from "./stash";
import { SWITCH_ACTIONS } from "./switch";
import { TAG_ACTIONS } from "./tag";

export { NETWORK_ACTIONS } from "./network";

export const ALL_ACTIONS: readonly Action[] = [
	...FILE_OPS_ACTIONS,
	...STAGING_ACTIONS,
	...COMMIT_ACTIONS,
	...BRANCH_ACTIONS,
	...MERGE_ACTIONS,
	...REBASE_ACTIONS,
	...CHERRY_PICK_ACTIONS,
	...REVERT_ACTIONS,
	...CONFLICT_ACTIONS,
	...STASH_ACTIONS,
	...TAG_ACTIONS,
	...REMOTE_ACTIONS,
	...NETWORK_ACTIONS,
	...RESET_ACTIONS,
	...CLEAN_ACTIONS,
	...SWITCH_ACTIONS,
	...RESTORE_ACTIONS,
	...DIAGNOSTIC_ACTIONS,
	...MAINTENANCE_ACTIONS,
];
