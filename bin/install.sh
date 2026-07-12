#!/usr/bin/env bash
# bin/install.sh — put the `kanban` (+ compatibility `fkanban`) shims on PATH
# in one step, so a bare `kanban <cmd>` resolves from any directory.
#
#   bun run install-cli            # auto-pick a PATH dir, symlink both shims
#   bun run install-cli ~/bin      # …or install into an explicit dir
#
# This is the durable counterpart to the doctor hint: the shims in bin/ already
# resolve back to this repo's src/, this just symlinks them onto PATH for you.
# Fully local + reversible — nothing is published to a registry, and the printed
# `rm` line removes it. Idempotent: re-running just refreshes the symlinks.
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Is directory $1 a member of $PATH? (the idiom reused below + in pick_dir)
on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Pick the install dir: an explicit arg wins; otherwise the first existing,
# writable, already-on-PATH candidate. We never modify PATH itself.
pick_dir() {
  if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
    printf '%s\n' "$1"
    return 0
  fi
  local candidates=("/usr/local/bin" "$HOME/.local/bin" "$HOME/bin")
  for d in "${candidates[@]}"; do
    if on_path "$d" && [ -d "$d" ] && [ -w "$d" ]; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

if ! target_dir="$(pick_dir "$@")"; then
  cat >&2 <<EOF
fkanban: could not find a writable directory on your PATH to install into.
Tried: /usr/local/bin, ~/.local/bin, ~/bin.

Pass one explicitly, e.g.:
  mkdir -p ~/.local/bin                       # create the dir if needed
  bun run install-cli ~/.local/bin            # symlink the shims into it
  export PATH="\$HOME/.local/bin:\$PATH"        # put it on PATH for this shell
                                              # (add that line to ~/.zshrc or
                                              #  ~/.bashrc to make it permanent)
EOF
  exit 1
fi

mkdir -p "$target_dir"

for name in kanban kanban-mcp fkanban fkanban-mcp; do
  ln -sf "$repo_root/bin/$name" "$target_dir/$name"
  echo "linked $target_dir/$name -> $repo_root/bin/$name"
done

echo
if on_path "$target_dir"; then
  echo "Done. \`kanban\`, \`kanban-mcp\`, \`fkanban\`, and \`fkanban-mcp\` are now on PATH."
  echo "Verify:  which kanban && kanban doctor && which fkanban"
  echo "Remove:  rm $target_dir/kanban $target_dir/kanban-mcp $target_dir/fkanban $target_dir/fkanban-mcp"
else
  # Honest warning: the shims are linked, but the dir isn't on PATH, so a bare
  # `fkanban` still won't resolve. Don't claim success we can't back up.
  cat >&2 <<EOF
Linked the kanban + compatibility fkanban shims into $target_dir, but $target_dir is not on your PATH.
Add it (current shell):   export PATH="$target_dir:\$PATH"
Make it permanent:        add that line to ~/.zshrc (or ~/.bashrc), then restart your shell.
Then verify:              which kanban && kanban doctor && which fkanban
Remove:                   rm $target_dir/kanban $target_dir/kanban-mcp $target_dir/fkanban $target_dir/fkanban-mcp
EOF
  # Exit non-zero so scripted installs detect the not-yet-usable state.
  exit 2
fi
