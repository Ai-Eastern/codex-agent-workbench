ARG BASE_IMAGE=workbench-desktop-isolation:20260911-v1
FROM ${BASE_IMAGE}
COPY requirements.toml /etc/codex/requirements.toml
COPY guard.py /opt/workbench-hooks/guard.py
RUN chmod 0555 /opt/workbench-hooks \
 && chmod 0444 /etc/codex/requirements.toml /opt/workbench-hooks/guard.py
