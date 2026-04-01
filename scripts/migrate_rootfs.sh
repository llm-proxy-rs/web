#!/usr/bin/env bash
#
# Migrates user rootfs files from the old flat layout to the new chroot layout.
#
# Old: {user_rootfs_dir}/{user_id}.ext4        (default: /home/ubuntu/fc-users/)
# New: {chroot_base}/firecracker/{user_id}/root/rootfs.ext4  (default: /srv/jailer/)
#
# Usage:
#   sudo ./scripts/migrate_rootfs.sh [old_dir] [chroot_base]
#
# Examples:
#   sudo ./scripts/migrate_rootfs.sh
#   sudo ./scripts/migrate_rootfs.sh /home/ubuntu/fc-users /srv/jailer

set -euo pipefail

OLD_DIR="${1:-/home/ubuntu/fc-users}"
CHROOT_BASE="${2:-/srv/jailer}"

if [ ! -d "$OLD_DIR" ]; then
    echo "Old rootfs directory not found: $OLD_DIR"
    echo "Nothing to migrate."
    exit 0
fi

count=0
skipped=0

for old_rootfs in "$OLD_DIR"/*.ext4; do
    [ -f "$old_rootfs" ] || continue

    filename="$(basename "$old_rootfs")"
    user_id="${filename%.ext4}"

    new_dir="$CHROOT_BASE/firecracker/$user_id/root"
    new_rootfs="$new_dir/rootfs.ext4"

    if [ -f "$new_rootfs" ]; then
        echo "SKIP  $user_id (already exists at $new_rootfs)"
        skipped=$((skipped + 1))
        continue
    fi

    echo "MOVE  $user_id"
    echo "  from: $old_rootfs"
    echo "  to:   $new_rootfs"

    mkdir -p "$new_dir"
    mv "$old_rootfs" "$new_rootfs"
    count=$((count + 1))
done

echo ""
echo "Done. Moved: $count, Skipped: $skipped"

if [ "$count" -gt 0 ]; then
    echo ""
    echo "You can remove the old directory once verified:"
    echo "  rm -rf $OLD_DIR"
fi
