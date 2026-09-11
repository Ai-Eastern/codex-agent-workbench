ARG NODE_BASE
FROM ${NODE_BASE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server ca-certificates git python3 procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @openai/codex@0.153.4 \
 && npm cache clean --force

RUN usermod --password '*' node \
 && mkdir -p /run/sshd /var/lib/workbench-ssh /home/node/.ssh /home/node/.codex /workspace/lianyu \
 && chown -R node:node /home/node /workspace/lianyu \
 && chmod 700 /home/node/.ssh /home/node/.codex /var/lib/workbench-ssh

COPY sshd_config /etc/ssh/sshd_config
COPY start-sshd.sh /usr/local/bin/start-workbench-sshd
RUN chmod 755 /usr/local/bin/start-workbench-sshd
WORKDIR /workspace/lianyu
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/start-workbench-sshd"]
