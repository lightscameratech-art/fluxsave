#!/bin/zsh
fluxsave_dir="/Users/admin/Documents/Codex/2026-07-28/a"
fluxsave_python="/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"

# Replace only a FluxSave server launched from this project folder. This makes
# reopening the launcher reliably load code updates without touching other apps.
for fluxsave_pid in $(/usr/sbin/lsof -tiTCP:8765 -sTCP:LISTEN 2>/dev/null); do
  fluxsave_cwd=$(/usr/sbin/lsof -a -p "$fluxsave_pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')
  if [[ "$fluxsave_cwd" == "$fluxsave_dir" ]]; then
    /bin/kill "$fluxsave_pid" 2>/dev/null
    for fluxsave_attempt in {1..20}; do
      /bin/kill -0 "$fluxsave_pid" 2>/dev/null || break
      /bin/sleep 0.1
    done
  fi
done

cd "$fluxsave_dir" || exit 1
exec "$fluxsave_python" fluxsave_server.py
