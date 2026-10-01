# This exact Phase 0 image already contains Python. Setup verifies local existence.
FROM agent-workspaces-phase0-code:2026-09-11
LABEL io.agent-workspaces.egress.policy="3"
WORKDIR /opt/agent-egress
COPY containers/egress/proxy.py containers/egress/fixture.py containers/egress/network_probe.py containers/egress/fixture-cert.pem containers/egress/fixture-key.pem ./
USER 65532:65532
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python3"]
CMD ["/opt/agent-egress/proxy.py"]
