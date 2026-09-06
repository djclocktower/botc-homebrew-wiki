#!/usr/bin/env bash
set -euo pipefail
umask 077
pocket_root="$(pwd)"
pocket_state="$HOME/.local/share/pocket-codex"
mkdir -p "$pocket_state" "$HOME/.local/bin"
if ! command -v codex >/dev/null 2>&1; then
  npm install --prefix "$pocket_state/runtime" @openai/codex@0.153.4 --no-audit --no-fund
  ln -sf "$pocket_state/runtime/node_modules/.bin/codex" "$HOME/.local/bin/codex"
fi
export PATH="$HOME/.local/bin:$PATH"
node - "$pocket_root" <<'NODE'
const fs=require('fs'),{execFileSync}=require('child_process');
const root=process.argv[2];const c=JSON.parse(fs.readFileSync(root+'/.pocket-codex/config.json'));
if(!fs.existsSync(c.workDir))execFileSync('git',['worktree','add','-b',c.workBranch,c.workDir,c.baseSha],{cwd:root,stdio:'inherit'});
NODE
bash "$pocket_root/.pocket-codex/start.sh"
