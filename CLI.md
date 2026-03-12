# CLI Reference

Auto-generated from command definitions.

## Top-level

```
git - Git command

Usage:
  git <command>

Commands:
  init         Initialize a new repository
  clone        Clone a repository into a new directory
  fetch        Download objects and refs from another repository
  pull         Fetch from and integrate with another repository
  push         Update remote refs along with associated objects
  add          Add file contents to the index
  blame        Show what revision and author last modified each line of a file
  commit       Record changes to the repository
  status       Show the working tree status
  log          Show commit logs
  branch       List, create, or delete branches
  tag          Create, list, or delete tags
  checkout     Switch branches or restore working tree files
  diff         Show changes between commits, commit and working tree, etc.
  reset        Reset current HEAD to the specified state
  merge        Join two or more development histories together
  cherry-pick  Apply the changes introduced by some existing commits
  revert       Revert some existing commits
  rebase       Reapply commits on top of another base tip
  mv           Move or rename a file, directory, or symlink
  rm           Remove files from the working tree and from the index
  remote       Manage set of tracked repositories
  config       Get and set repository options
  show         Show various types of objects
  stash        Stash the changes in a dirty working directory away
  rev-parse    Pick out and massage parameters
  ls-files     Show information about files in the index and the working tree
  clean        Remove untracked files from the working tree
  switch       Switch branches
  restore      Restore working tree files
  reflog       Manage reflog information
  repack       Pack unpacked objects in a repository
  gc           Cleanup unnecessary files and optimize the local repository
```

## git add

```
git add - Add file contents to the index

Usage:
  git add [options] [paths...]

Arguments:
  paths...  Pathspec of files to add

Options:
  -A, --all      Add changes from all tracked and untracked files
  -f, --force    Allow adding otherwise ignored files
  -u, --update   Update tracked files
  -n, --dry-run  Don't actually add the file(s)
```

## git blame

```
git blame - Show what revision and author last modified each line of a file

Usage:
  git blame [options] [args...]

Arguments:
  args...

Options:
  -L, --line-range <string>  Annotate only the given line range (<start>,<end>)
  -l, --long                 Show long revision
  -e, --show-email           Show author email instead of name
  -s, --suppress             Suppress author name and date
  -p, --porcelain            Show in machine-readable format
  --line-porcelain           Show porcelain format with full headers for each line
```

## git branch

```
git branch - List, create, or delete branches

Usage:
  git branch [options] [name] [newName]

Arguments:
  name     Branch name
  newName  New branch name (for -m) or start-point (for create)

Options:
  -d, --delete                    Delete a branch
  -D, --force-delete              Force delete a branch
  -m, --move                      Rename a branch
  -M, --force-move                Force rename a branch
  -r, --remotes                   List remote-tracking branches
  -a, --all                       List all branches
  -u, --set-upstream-to <string>  Set upstream tracking branch
  -v, --verbose                   Show hash and subject (counted)
```

## git checkout

```
git checkout - Switch branches or restore working tree files

Usage:
  git checkout [options] [target]

Arguments:
  target  Branch name or path to checkout

Options:
  -b, --branch        Create and switch to a new branch
  -B, --force-branch  Create/reset and switch to a new branch
  --orphan            Create a new orphan branch
  --ours              Checkout our version for unmerged files
  --theirs            Checkout their version for unmerged files
```

## git cherry-pick

```
git cherry-pick - Apply the changes introduced by some existing commits

Usage:
  git cherry-pick [options] [commit]

Arguments:
  commit  The commit to cherry-pick

Options:
  --abort                  Abort the current cherry-pick operation
  --continue               Continue the cherry-pick after conflict resolution
  --skip                   Skip the current cherry-pick and continue with the rest
  -x, --record-origin      Append "(cherry picked from commit ...)" to the commit message
  -m, --mainline <number>  Select parent number for merge commit (1-based)
  -n, --no-commit          Apply changes without creating a commit
```

## git clean

```
git clean - Remove untracked files from the working tree

Usage:
  git clean [options] [pathspec...]

Arguments:
  pathspec...  Pathspec to limit which files are removed

Options:
  -f, --force             Required to actually remove files
  -n, --dry-run           Don't actually remove anything, just show what would be done
  -d, --directories       Also remove untracked directories
  -x, --remove-ignored    Remove ignored files as well
  -X, --only-ignored      Remove only ignored files
  -e, --exclude <string>  Additional exclude pattern
```

## git clone

```
git clone - Clone a repository into a new directory

Usage:
  git clone [options] <repository> [directory]

Arguments:
  repository  Repository to clone (required)
  directory   Target directory

Options:
  --bare                 Create a bare clone
  -b, --branch <string>  Checkout this branch instead of HEAD
```

## git commit

```
git commit - Record changes to the repository

Usage:
  git commit [options]

Options:
  -m, --message <string>  Commit message
  -F, --file <string>     Read commit message from file ('-' for stdin)
  --allow-empty           Allow creating an empty commit
  --amend                 Amend the previous commit
  --no-edit               Use the previous commit message without editing
  -a, --all               Auto-stage modified and deleted tracked files
```

## git config

```
git config - Get and set repository options

Usage:
  git config [options] [positionals...]

Arguments:
  positionals...

Options:
  -l, --list  List all config entries
  --unset     Remove a config key
```

## git diff

```
git diff - Show changes between commits, commit and working tree, etc.

Usage:
  git diff [options] [commits...]

Arguments:
  commits...

Options:
  --cached       Show staged changes (index vs HEAD)
  --staged       Synonym for --cached
  --stat         Show diffstat summary
  --name-only    Show only names of changed files
  --name-status  Show names and status of changed files
  --shortstat    Show only the shortstat summary line
  --numstat      Machine-readable insertions/deletions per file
```

## git fetch

```
git fetch - Download objects and refs from another repository

Usage:
  git fetch [options] [remote] [refspec...]

Arguments:
  remote      Remote to fetch from
  refspec...  Refspec(s) to fetch

Options:
  --all        Fetch from all remotes
  -p, --prune  Remove stale remote-tracking refs
  --tags       Also fetch tags
```

## git gc

```
git gc - Cleanup unnecessary files and optimize the local repository

Usage:
  git gc [options]

Options:
  --aggressive  More aggressively optimize the repository
```

## git init

```
git init - Initialize a new repository

Usage:
  git init [options] [directory]

Arguments:
  directory  The directory to initialize

Options:
  --bare                         Create a bare repository
  -b, --initial-branch <string>  Name for the initial branch

Examples:
  git init
  git init --bare
  git init my-project
```

## git log

```
git log - Show commit logs

Usage:
  git log [options] [revisions...]

Arguments:
  revisions...

Options:
  -n, --max-count <number>  Limit the number of commits to output
  --oneline                 Condense each commit to a single line
  --all                     Walk all refs, not just HEAD
  --author <string>         Filter by author (regex or substring)
  --grep <string>           Filter by commit message (regex or substring)
  --since <string>          Show commits after date
  --after <string>          Synonym for --since
  --until <string>          Show commits before date
  --before <string>         Synonym for --until
  --decorate                Show ref names next to commit hashes
  --reverse                 Output commits in reverse order
  --format <string>         Pretty-print format string
  --pretty <string>         Pretty-print format or preset name
```

## git ls-files

```
git ls-files - Show information about files in the index and the working tree

Usage:
  git ls-files [options]

Options:
  -c, --cached         Show cached files (default)
  -m, --modified       Show modified files
  -d, --deleted        Show deleted files
  -o, --others         Show other (untracked) files
  -u, --unmerged       Show unmerged files
  -s, --stage          Show staged contents' mode, hash, and stage number
  --exclude-standard   Add standard git exclusions (.gitignore, info/exclude, core.excludesFile)
  -z, --nul-terminate  Use \0 as line terminator instead of \n
  -t, --show-tags      Show status tags
```

## git merge

```
git merge - Join two or more development histories together

Usage:
  git merge [options] [branch]

Arguments:
  branch  Branch to merge into the current branch

Options:
  --abort                 Abort the current in-progress merge
  --continue              Continue the merge after conflict resolution
  --no-ff                 Create a merge commit even when fast-forward is possible
  --ff-only               Refuse to merge unless fast-forward is possible
  --squash                Apply merge result to worktree/index without creating a merge commit
  --edit                  Edit the merge message (no-op, accepted for compatibility)
  -m, --message <string>  Merge commit message
```

## git mv

```
git mv - Move or rename a file, directory, or symlink

Usage:
  git mv [options] [sources...]

Arguments:
  sources...  Source file(s) or directory

Options:
  -f, --force    Force renaming even if target exists
  -n, --dry-run  Do nothing; only show what would happen
  -k, --skip     Skip move/rename actions that would lead to errors
```

## git pull

```
git pull - Fetch from and integrate with another repository

Usage:
  git pull [options] [remote] [branch]

Arguments:
  remote  Remote to pull from
  branch  Remote branch

Options:
  -r, --rebase  Rebase instead of merge
  --no-rebase   Merge instead of rebase
  --ff-only     Only fast-forward
  --no-ff       Create a merge commit even for fast-forwards
```

## git push

```
git push - Update remote refs along with associated objects

Usage:
  git push [options] [remote] [refspec...]

Arguments:
  remote      Remote to push to
  refspec...  Refspec(s) to push

Options:
  -f, --force         Force push
  -u, --set-upstream  Set upstream tracking reference
  --all               Push all branches
  -d, --delete        Delete remote refs
  --tags              Push all tags
```

## git rebase

```
git rebase - Reapply commits on top of another base tip

Usage:
  git rebase [options] [upstream]

Arguments:
  upstream  Upstream branch to rebase onto

Options:
  --onto <string>  Starting point at which to create new commits
  --abort          Abort the current rebase operation
  --continue       Continue the rebase after conflict resolution
  --skip           Skip the current patch and continue
```

## git reflog

```
git reflog - Manage reflog information

Usage:
  git reflog [options] [args...]

Arguments:
  args...

Options:
  -n, --max-count <number>  Limit the number of entries to output
```

## git remote

```
git remote - Manage set of tracked repositories

Usage:
  git remote <command> [options]

Commands:
  add      Add a remote named <name> for the repository at <url>
  remove   Remove the remote named <name>
  rm       Remove the remote named <name>
  rename   Rename the remote named <old> to <new>
  set-url  Change the URL for an existing remote
  get-url  Retrieve the URL for an existing remote

Options:
  -v, --verbose  Show remote URLs
```

### git remote add

```
git remote add - Add a remote named <name> for the repository at <url>

Usage:
  git remote add <name> <url>

Arguments:
  name  Remote name (required)
  url   Remote URL (required)
```

### git remote get-url

```
git remote get-url - Retrieve the URL for an existing remote

Usage:
  git remote get-url <name>

Arguments:
  name  Remote name (required)
```

### git remote remove

```
git remote remove - Remove the remote named <name>

Usage:
  git remote remove <name>

Arguments:
  name  Remote name (required)
```

### git remote rename

```
git remote rename - Rename the remote named <old> to <new>

Usage:
  git remote rename <old> <new>

Arguments:
  old  Current remote name (required)
  new  New remote name (required)
```

### git remote rm

```
git remote rm - Remove the remote named <name>

Usage:
  git remote rm <name>

Arguments:
  name  Remote name (required)
```

### git remote set-url

```
git remote set-url - Change the URL for an existing remote

Usage:
  git remote set-url <name> <url>

Arguments:
  name  Remote name (required)
  url   New remote URL (required)
```

## git repack

```
git repack - Pack unpacked objects in a repository

Usage:
  git repack [options]

Options:
  -a, --all     Pack all objects, including already-packed
  -d, --delete  After packing, remove redundant packs and loose objects
```

## git reset

```
git reset - Reset current HEAD to the specified state

Usage:
  git reset [options] [args...]

Arguments:
  args...

Options:
  --soft   Only move HEAD
  --mixed  Move HEAD and reset index (default)
  --hard   Move HEAD, reset index, and reset working tree
```

## git restore

```
git restore - Restore working tree files

Usage:
  git restore [options] [pathspec...]

Arguments:
  pathspec...

Options:
  -s, --source <string>  Restore from tree-ish
  -S, --staged           Restore the index
  -W, --worktree         Restore the working tree (default)
  --ours                 Checkout our version for unmerged files
  --theirs               Checkout their version for unmerged files
```

## git rev-parse

```
git rev-parse - Pick out and massage parameters

Usage:
  git rev-parse [options] [args...]

Arguments:
  args...  Refs or revision expressions to resolve

Options:
  --verify               Verify that exactly one parameter is provided and resolves to an object
  --short                Abbreviate object name (default 7 chars)
  --abbrev-ref           Output abbreviated ref name instead of object hash
  --symbolic-full-name   Output the full symbolic ref name
  --show-toplevel        Show the absolute path of the top-level directory
  --git-dir              Show the path to the .git directory
  --is-inside-work-tree  Output whether cwd is inside the work tree
  --is-bare-repository   Output whether the repository is bare
  --show-prefix          Show path of cwd relative to top-level directory
  --show-cdup            Show relative path from cwd up to top-level directory
```

## git revert

```
git revert - Revert some existing commits

Usage:
  git revert [options] [commit]

Arguments:
  commit  The commit to revert

Options:
  --abort                  Abort the current revert operation
  --continue               Continue the revert after conflict resolution
  -n, --no-commit          Apply changes without creating a commit
  --no-edit                Do not edit the commit message
  -m, --mainline <number>  Select the parent number for reverting merges
```

## git rm

```
git rm - Remove files from the working tree and from the index

Usage:
  git rm [options] [paths...]

Arguments:
  paths...  Files to remove

Options:
  --cached         Only remove from the index
  -r, --recursive  Allow recursive removal when a directory name is given
  -f, --force      Override the up-to-date check
  -n, --dry-run    Don't actually remove any file(s)
```

## git show

```
git show - Show various types of objects

Usage:
  git show [object...]

Arguments:
  object...
```

## git stash

```
git stash - Stash the changes in a dirty working directory away

Usage:
  git stash <command> [options]

Commands:
  push   Save your local modifications to a new stash entry
  pop    Remove a single stash entry and apply it on top of the current working tree
  apply  Apply a stash entry on top of the current working tree
  list   List the stash entries that you currently have
  drop   Remove a single stash entry from the list of stash entries
  show   Show the changes recorded in a stash entry as a diff
  clear  Remove all the stash entries

Options:
  -m, --message <string>   Stash message
  -u, --include-untracked  Also stash untracked files
```

### git stash apply

```
git stash apply - Apply a stash entry on top of the current working tree

Usage:
  git stash apply [stash]

Arguments:
  stash  Stash reference (e.g. stash@{0})
```

### git stash clear

```
git stash clear - Remove all the stash entries

Usage:
  git stash clear
```

### git stash drop

```
git stash drop - Remove a single stash entry from the list of stash entries

Usage:
  git stash drop [stash]

Arguments:
  stash  Stash reference (e.g. stash@{0})
```

### git stash list

```
git stash list - List the stash entries that you currently have

Usage:
  git stash list
```

### git stash pop

```
git stash pop - Remove a single stash entry and apply it on top of the current working tree

Usage:
  git stash pop [stash]

Arguments:
  stash  Stash reference (e.g. stash@{0})
```

### git stash push

```
git stash push - Save your local modifications to a new stash entry

Usage:
  git stash push [options]

Options:
  -m, --message <string>   Stash message
  -u, --include-untracked  Also stash untracked files
```

### git stash show

```
git stash show - Show the changes recorded in a stash entry as a diff

Usage:
  git stash show [stash]

Arguments:
  stash  Stash reference (e.g. stash@{0})
```

## git status

```
git status - Show the working tree status

Usage:
  git status [options]

Options:
  -s, --short   Give the output in the short-format
  --porcelain   Give the output in a machine-parseable format
  -b, --branch  Show the branch in short-format output
```

## git switch

```
git switch - Switch branches

Usage:
  git switch [options] [branch-or-start-point]

Arguments:
  branch-or-start-point  Branch to switch to, or start-point for -c/-C

Options:
  -c, --create <string>        Create and switch to a new branch
  -C, --force-create <string>  Create/reset and switch to a branch
  -d, --detach                 Detach HEAD at named commit
  --orphan <string>            Create a new orphan branch
  --guess                      Guess branch from remote tracking (default: true)
```

## git tag

```
git tag - Create, list, or delete tags

Usage:
  git tag [options] [name] [commit]

Arguments:
  name    Tag name to create or delete
  commit  Commit to tag (defaults to HEAD)

Options:
  -a, --annotate          Make an annotated tag object
  -m, --message <string>  Tag message
  -d, --delete            Delete a tag
  -f, --force             Replace an existing tag
  -l, --list <string>     List tags matching pattern
```
