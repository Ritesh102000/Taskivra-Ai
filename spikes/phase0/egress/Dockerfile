# Reuse the locally built Phase 0 code runtime; no new base image is pulled here.
ARG BASE_IMAGE=agent-workspaces-phase0-code:2026-09-11
FROM ${BASE_IMAGE}
USER root
WORKDIR /opt/agent-egress
COPY proxy.py fixture.py network_probe.py fixture-cert.pem fixture-key.pem ./
RUN chmod -R a=rX /opt/agent-egress
USER 65532:65532
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python3"]
CMD ["/opt/agent-egress/proxy.py"]
