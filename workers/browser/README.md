# Browser worker, protocol 3

This is the bounded browser process inside each agent's container. The desktop
renderer and models never receive Playwright objects, selectors, CDP, profile
paths, Docker access or a shell. The runtime owns the framed stdin/stdout pipe.
Only HTTP/HTTPS navigation is accepted; the separate proxy/network enforces
destination restrictions. Service workers, permission prompts, QUIC and direct
WebRTC UDP are disabled. Page-reported permission denials are bounded metadata,
not capability grants.

The image uses the exact previously verified Phase 0 Playwright/Chromium base.
Startup is a restore handshake; Chromium starts only after the broker invokes
`session.launch`. Actual renderer namespaces, extra seccomp filters, zero
capabilities, non-root identity and the absence of sandbox-disabling flags are
attested before a session is returned. A failed attestation closes Chromium.

## Transport and ownership

Messages are a four-byte big-endian JSON byte length followed by UTF-8 JSON.
Requests are at most 256 KiB; responses at most 3 MiB; at most 32 requests are
pending. Output backpressure is bounded to 8 MiB. File chunks are at most
128 KiB before base64 encoding. There is no line-based log/control multiplexing.

Every request is `{id,method,actor,generation,params}`. Actor is `agent`, `human`,
`owner` or `broker`; only the trusted runtime can choose it. The generation starts
at the coordinator's persisted `BROWSER_INITIAL_GENERATION`, rather than resetting
after a container restart. Takeover immediately fences queued commands, waits for
the active bounded operation, and suppresses its old-controller result. Unknown
external action outcomes are never automatically replayed. Returning control
requires an explicit fresh agent observation before another agent mutation.

`owner` issues only controller changes. `human` and `agent` issue browser input
for their current controller. Broker-only lifecycle, transfers and profile
methods still check the current generation. The broker can observe/list tabs
during either controller without granting page input.

## Browser API

| Method | Params | Result |
|---|---|---|
| `tabs.list` | `{}` | Tab array |
| `tabs.open` | `{url}` | Observation; exact `about:blank` is also supported here |
| `tabs.close` | `{tab}` | `{tabs,selectedTabId}`; closing the last tab leaves a blank tab |
| `page.navigate` | `{tab,url}` | Observation |
| `page.observe` | `{tab?,screenshot?}` | Observation |
| `page.click` | `{tab,revision,ref}` or human-only `{tab,revision,x,y}` | Observation |
| `page.fill` | `{tab,revision,ref,value}` | Observation |
| `page.key` | `{tab,revision,text}` or `{tab,revision,key}` | Observation |
| `page.scroll` | `{tab,revision,x,y}` | Observation |
| `control.take` | `{tab?}` | `{observation}` |
| `control.release` | `{tab?}` | `{tabs,selectedTabId,requiresFreshObservation:true}` |

Observation is `{tabs,selectedTabId,tab,url,title,text,revision,targets,frame,permissions}`.
Tabs are `{id,title,url,revision}`. Targets are `{ref,kind,label,password}`;
`kind` is `input`, `file`, `select`, `link` or `button`. Opaque references retain
element identity and are replaced on every observation. Navigation and observed
DOM mutation invalidate them. No input values are extracted. Agent password
fill or keyboard input requires human login instead.

The viewport is 1120×760; JPEG bytes are at most 2 MiB. `frame` is
`{jpegBase64,width,height,revision,tabId}` for owner/broker/human observations and
`null` for agent observations. Text is capped at 16,000 characters; 150 semantic
targets are selected from at most 10,000 walked DOM elements. Labels are capped
at 160 characters. The worker creates no screenshots, credential logs or action
traces on disk. Owner input must also remain absent from coordinator events.

There are at most six pages per session; popups are registered in the creating
session and excess pages close. Browser operations have Playwright deadlines,
and the host transport independently kills an unresponsive worker. Native
passkeys, provider MFA and clipboard interactions are not proven by the synthetic
fixture; the owner can leave a task waiting when a site cannot complete login.

## Authorized file transfers

All transfer commands are broker-only; paths never enter the protocol.

1. `upload.begin({name,bytes,sha256,versionId,tab,revision,ref,origin})` returns
   `{id,chunkBytes}`. The selected opaque ref must be a file input at the exact
   current HTTP(S) origin. Its form action and all submit-button action overrides
   must remain at that origin.
2. `upload.chunk({id,offset,base64})` accepts sequential bounded chunks.
3. `upload.finish({id})` verifies the full hash and repeats the generation,
   origin, target and revision checks before selecting the file. It returns
   `{uploaded:true,versionId,observation}`. This means the file input received the
   bytes; it does not claim that the website accepted a form submission.
4. `upload.abort({id})` removes an unused stage. Successfully selected files
   remain staged until context closure because Chromium may read them during a
   later form submission. The source filename is preserved under an opaque
   transfer directory. All held stages continue counting toward capacity.

The page gains access to selected bytes and its JavaScript can forward them.
Form-origin checks are not a promise of application-level data-loss prevention.
The coordinator must authorize that page's access and serialize the complete
transfer against frame polling, since observations replace input references.

`download.list({})` returns `{id,name,tabId,origin,bytes,completed,status,sha256?}`
rows. Tab and origin provenance are captured when the download starts. The broker
reads completed bytes with `download.read({id,offset,length?})`, independently
persists/verifies them as private artifacts, then calls `download.ack({id})`.
Chunks return `{offset,base64,eof}`. Pending downloads cannot be read or
acknowledged. Failed downloads are explicit failed entries. Normal context close
refuses any unacknowledged download; force-stop can discard pending work.
`download.cancel({id})` cancels a pending transfer and marks it failed/completed;
the broker can then acknowledge it before saving the profile on normal close.

Each file is at most 100 MiB, with 32 held transfers and a 128 MiB aggregate
transfer allowance. Partial downloads are monitored and cancelled on excess;
the separate 256 MiB `/transfers` tmpfs remains the hard storage boundary.
All transfer reads reject paths, links, special files and changed file identity.

## Local login profiles

Profile bytes never appear in observations or model tools. The runtime restores
its encrypted, owner-managed profile through broker methods before launch:

```
profile.restore.begin({})
profile.restore.file({path,bytes,sha256})
profile.restore.chunk({path,offset,base64})  # repeat as needed per file
profile.restore.finish({})
session.launch({})                        # returns {sandbox,observation,phase}
```

For small manifests, `restore.begin({files:[...]})` is also accepted. There are
at most 4,096 regular files and 256 MiB total; paths are relative, at most 512
characters, and cannot contain traversal, empty segments, backslashes or links.
Restore verifies ordered lengths and complete hashes before Chromium starts.

After downloads are persisted and acknowledged, `session.close({})` flushes and
closes Chromium before building a stable regular-file manifest. Its result is
`{phase:'closed',profile:{files:[{path,bytes,sha256}],bytes}}`. The runtime obtains
each file through `profile.read({path,offset,length?})`, independently validates
and atomically commits the encrypted checkpoint, then removes its worker.
No archive extraction is involved. Only Chromium's three known singleton
bookkeeping names are omitted. Changed files fail checkpointing and the runtime
retains the prior durable revision. Crash-stop cannot claim to save live cookies.

## Verification

```
npx tsx --test tests/phase3/worker.test.ts
AW_BROWSER_DOCKER_TEST=1 npx tsx --test tests/phase3/worker-delay.test.ts
AW_BROWSER_DOCKER_TEST=1 npx tsx --test tests/phase3/worker-docker.test.ts
```

The Docker test is explicit and uses only synthetic credentials. Its evidence
report omits screenshots, entered values and profiles. It checks sandbox proof,
container limits, separate logins, three tabs per agent, popup ownership,
takeover/fresh-state fencing, checked transfers, profile restart, and peer
continuity after one worker is killed. All resources are scoped and cleaned by
the runtime's ownership journal.

The delayed-input regression waits 250 ms after observing an editable page before
clicking. Screenshots retain the original caret styling, and DOM notifications
use MutationObserver's native microtask batching. Screenshot styling and old
timer-delayed mutations therefore do not invalidate an otherwise current frame;
genuine page mutations still fence stale input.
