# Phase 0 browser egress spike

This is a feasibility component and deterministic test harness. It does not
implement the application coordinator, task permissions, or model tool broker.

The production-default proxy permits HTTP/WebSocket on TCP 80 and TLS
CONNECT for HTTPS/secure WebSocket on TCP 443. Each new connection resolves the
destination, rejects the entire answer set if any address is non-public, and
connects to a checked numeric IP. It never resolves the hostname again while
connecting. Private/loopback/link-local/metadata/service addresses, multicast,
IPv4-mapped IPv6, transition/NAT64 ranges, unsupported ports, and local service
names are denied. A redirect or subresource is another independently checked
request. HTTPS tunnels stay pinned to their original checked destination.

The proxy is only one part of the boundary. The harness gives each browser its
own Docker `--internal` bridge with `gateway_mode_ipv4=isolated`. Ordinary
`--internal` alone allows access to the bridge's host address. The browser has
no default external route, no network administration/raw socket capabilities,
and no shared network with another browser. Only its proxy joins this internal
bridge and a separate outbound bridge. The proxy listens on its internal IP,
has IP forwarding disabled, and publishes no host port. The harness also
publishes no fixture/probe/management ports.

Browser DNS upstream is explicitly `127.0.0.1`; Docker's embedded resolver at
`127.0.0.11` can resolve the local `egress` alias but cannot forward browser DNS
to the host resolver. External name resolution happens in the proxy. IPv6 is
disabled in the initial browser namespace. These settings accompany the
browser worker's proxy, loopback-bypass exclusion, and non-proxied WebRTC-UDP
disable flags. The network probes use raw TCP/UDP without browser flags to
test that the external boundary also blocks direct bypass.

## Reproduction

From the repository root, with the selected Docker daemon already running:

```sh
python3 -m unittest discover -s tests/phase0 -p 'egress_test.py' -v
```

Build only after the Phase 0 code image exists locally. No package install is
performed here; Python's standard library is sufficient. The resulting image
is inspected and pinned by the runtime harness. Never substitute an unreviewed pulled tag
while interpreting existing evidence.

```sh
docker build --pull=false --network=none \
  --build-arg BASE_IMAGE=agent-workspaces-phase0-code:2026-09-11 \
  -t agent-workspaces-phase0-egress:2026-09-11 spikes/phase0/egress

python3 spikes/phase0/egress/harness.py up \
  --image agent-workspaces-phase0-egress:2026-09-11 \
  --state spikes/phase0/egress/.runtime/check.json --test-fixture

python3 spikes/phase0/egress/harness.py check \
  --state spikes/phase0/egress/.runtime/check.json --public

python3 spikes/phase0/egress/harness.py down \
  --state spikes/phase0/egress/.runtime/check.json
```

`--public` makes one HTTPS request to `example.com` through the proxy and
attempts a denied direct TCP connection to an address resolved for that site.
Omit it for the deterministic local checks only. The check also creates a
short-lived empty host canary, verifies it is reachable from the trusted
outbound namespace, and proves the browser namespace cannot connect to it.

To test the host deadline explicitly, run `check --probe-timeout 0.1` against
a live fixture state. A failed probe result is expected, while
`probe_cleanup_completed` must remain true. The named probe is recorded before
launch and removed in `finally`, including after a Docker CLI timeout. Cleanup
requires matching labels and never removes unrelated containers/networks.
Incomplete provisioning records its resource names before creating them;
if cleanup fails, retain the state file and run `down` with that exact path.
Close any browser workers attached to a supplied network before `down`.

## Browser integration contract

`up` prints and saves:

- `browser_network`: exclusively for one browser agent.
- `browser_environment.BROWSER_PROXY_SERVER`: `http://egress:3128`.
- `required_browser_network_args`: DNS override plus IPv6-disable sysctls.
- `fixture_url` when explicitly testing: `http://fixture.agent-workspaces.test:8080`.

Provision another independent topology for a second agent. Never put two
browser agents on one internal bridge. Browser control remains on the worker's
framed stdin/stdout transport; it is not a network service.

The fixture exemption requires both `EGRESS_TEST_ONLY=1` and an exact
`EGRESS_TEST_FIXTURE_IP` in the trusted proxy environment. Only the fixed
fixture hostname and port 8080/8443 can use it. A URL containing the private
fixture IP itself is still rejected. The production default has no exemption.
The fixture lives on another isolated network and cannot be reached directly
from the browser network. It supplies synthetic login, HTTP/TLS, WS/WSS, and
private-redirect cases. Its committed certificate and private key are public
test material, generated for this fixture only; they are not user credentials
or suitable for any real service.

## Evidence and remaining boundaries

`integration-evidence.json` records UTC time, Docker version, exact image ID,
host source hashes, hashes of source actually installed in the running image,
individual checks, and limitations. `unit-evidence.txt` records the policy and
HTTP parsing tests. `timeout-evidence.json` records deliberate deadline failure
and cleanup. Historical evidence remains valid for the recorded image/source;
re-run after changing them.

This initial proxy rejects chunked request uploads and `Expect: 100-continue`,
does not pool HTTP connections, and bounds headers (32 KiB), request bodies
(100 MiB), tunnel transfers (128 MiB), sessions (300 s), idle time (20 s), and
concurrent connections (32). Sites requiring larger uploads, nonstandard ports,
or unsupported HTTP framing need a documented policy/compatibility decision.

TLS CONNECT checks the initial TLS record and destination; it does not decrypt
traffic or establish that all encrypted bytes are HTTP. Artifact-upload grants
and destination authorization still belong in the broker. A public website can
receive permitted web traffic; this proxy is not a content-disclosure policy.
The tests do not prove defense against every kernel/browser/proxy exploit,
live IPv6 routing (the browser disables it), every UDP application, arbitrary
DNS tunnelling technique, or real-device MFA/passkey compatibility. DNS
rebinding rejection and IPv6 classifications have deterministic unit coverage;
the Docker test demonstrates the concrete namespace, DNS, TCP, and UDP cases
recorded in the evidence.

Official basis: [Docker internal networks](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal),
[isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes),
[Docker DNS configuration](https://docs.docker.com/engine/network/#dns-services),
and [bridge isolation](https://docs.docker.com/engine/network/drivers/bridge/).
