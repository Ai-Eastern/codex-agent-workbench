#!/bin/sh
set -eu
if [ ! -f /var/lib/workbench-ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /var/lib/workbench-ssh/ssh_host_ed25519_key
fi
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
