#!/bin/sh
set -eu

/usr/bin/docker exec nginx-proxy-manager certbot renew \
  --cert-name rasp.gymn19.ru \
  --no-random-sleep-on-renew \
  --quiet \
  --config-dir /etc/letsencrypt \
  --work-dir /tmp/letsencrypt-lib \
  --logs-dir /data/logs \
  --deploy-hook 'nginx -s reload'
