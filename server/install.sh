#!/bin/sh
set -eu

APP=/srv/schedule-web
ARCHIVE=/tmp/schedule-web-deploy.tar
PUBLISH_KEY=${PUBLISH_KEY:-}

test "$(id -u)" -eq 0
test -f "$ARCHIVE"
test -n "$PUBLISH_KEY" || { echo 'Set PUBLISH_KEY to the publisher SSH public key' >&2; exit 2; }

if ! getent passwd schedule-publisher >/dev/null; then
    useradd --create-home --shell /bin/bash --comment 'Gymn19 schedule publisher' schedule-publisher
fi

install -d -m 700 -o schedule-publisher -g schedule-publisher /home/schedule-publisher/.ssh
printf '%s\n' "$PUBLISH_KEY" > /home/schedule-publisher/.ssh/authorized_keys
chown schedule-publisher:schedule-publisher /home/schedule-publisher/.ssh/authorized_keys
chmod 600 /home/schedule-publisher/.ssh/authorized_keys

if [ -e "$APP" ]; then
    stamp=$(date +%Y%m%d-%H%M%S)
    mkdir -p /root/backups/schedule-web
    tar -C /srv -czf "/root/backups/schedule-web/existing-schedule-web-$stamp.tar.gz" schedule-web
    mv "$APP" "$APP.previous-$stamp"
fi

install -d -m 755 "$APP"
tar --no-same-owner -xf "$ARCHIVE" -C "$APP"
install -d -m 755 "$APP/bin"
install -d -m 755 -o schedule-publisher -g schedule-publisher "$APP/uploads" "$APP/releases"
if [ -d "$APP/site/data" ]; then
    mv "$APP/site/data" "$APP/releases/initial"
else
    install -d -m 755 "$APP/releases/initial"
fi
chown -R schedule-publisher:schedule-publisher "$APP/releases/initial"
ln -s ../releases/current "$APP/site/data"
ln -s initial "$APP/releases/current"

cat > "$APP/bin/activate-release" <<'ACTIVATE'
#!/bin/sh
set -eu
APP=/srv/schedule-web
archive=${1:-}
stamp=${2:-}
case "$archive" in "$APP"/uploads/*.tar) ;; *) echo 'invalid archive path' >&2; exit 2 ;; esac
printf '%s' "$stamp" | grep -Eq '^[0-9]{8}-[0-9]{6}$' || { echo 'invalid release name' >&2; exit 2; }
test -f "$archive"
stage="$APP/releases/$stamp.new"
release="$APP/releases/$stamp"
test ! -e "$stage"
test ! -e "$release"
mkdir "$stage"
tar --no-same-owner -xf "$archive" -C "$stage"
test -s "$stage/index.html"
test -s "$stage/version.json"
mv "$stage" "$release"
ln -s "$stamp" "$APP/releases/current.next"
mv -Tf "$APP/releases/current.next" "$APP/releases/current"
rm -f "$archive"
printf 'activated %s\n' "$stamp"
ACTIVATE
chown root:root "$APP/bin/activate-release"
chmod 755 "$APP/bin/activate-release"

cd "$APP"
docker compose up -d
printf 'schedule web installed\n'
