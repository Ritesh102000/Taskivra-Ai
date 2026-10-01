# ARM64 manifest verified through Docker Hub; build records actual image ID.
FROM node:24.14.0-alpine3.23@sha256:0e0d39e04fdf3dc5f450a07922573bac666d28920df2df3f3b1540b0aba7ab98
ARG PYTHON_APK_VERSION
RUN test -n "$PYTHON_APK_VERSION" && apk add --no-cache "python3=$PYTHON_APK_VERSION" \
    && mkdir -p /opt/phase0 /workspace /shared \
    && printf 'item,value\napproved,3\n' > /shared/allowed.csv \
    && chmod 0555 /shared && chmod 0444 /shared/allowed.csv
COPY export_protocol.py supervisor.py /opt/phase0/
RUN chmod -R a-w /opt/phase0
WORKDIR /opt/phase0
ENTRYPOINT ["python3", "-I", "/opt/phase0/supervisor.py", "init"]
