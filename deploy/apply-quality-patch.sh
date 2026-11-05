#!/usr/bin/env bash
set -euo pipefail
PACKAGE=${1:?Usage: apply-quality-patch.sh /path/to/chapter-agent-quality-patch.tar.gz}
DEPLOY_ROOT=${2:-/opt/chapter-agent}
PACKAGE=$(cd "$(dirname "$PACKAGE")" && pwd)/$(basename "$PACKAGE")
cd "$DEPLOY_ROOT"
PATCH_BACKUP="$DEPLOY_ROOT/patch-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PATCH_BACKUP"
BACKUP_PATHS=(backend/app prompts frontend/dist)
if [ -d frontend/src ]; then BACKUP_PATHS+=(frontend/src); fi
tar -czf "$PATCH_BACKUP/code.tar.gz" "${BACKUP_PATHS[@]}"
backend/venv/bin/python - "$PACKAGE" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1]) as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        allowed = member.name.startswith(('backend/app/', 'frontend/dist/', 'frontend/src/', 'prompts/verification.md', 'prompts/phase_generate.md', 'prompts/phase_understand.md', 'prompts/psychology_qa.md', 'scripts/migrate-quality.py'))
        if path.is_absolute() or '..' in path.parts or not member.isfile() or not allowed:
            raise SystemExit('Invalid patch member: ' + member.name)
PY
systemctl stop chapter-agent-backend
restore_on_failure() {
    code=$?
    if [ "$code" -ne 0 ]; then
        tar -xzf "$PATCH_BACKUP/code.tar.gz" --no-same-owner
    fi
    systemctl start chapter-agent-backend
    exit "$code"
}
trap restore_on_failure EXIT
tar -xzf "$PACKAGE" --no-same-owner
backend/venv/bin/python -m compileall -q -x '(^|/)\._' backend/app
backend/venv/bin/python scripts/migrate-quality.py --apply > "$PATCH_BACKUP/migration.json"
systemctl start chapter-agent-backend
for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 5 http://127.0.0.1:8000/api/health > /dev/null; then
        echo "Patch applied. Backup: $PATCH_BACKUP"
        exit 0
    fi
    sleep 1
done
echo "Backend did not become healthy. Backup: $PATCH_BACKUP" >&2
exit 1
