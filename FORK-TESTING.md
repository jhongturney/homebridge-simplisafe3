# Staged testing fork

This fork keeps the `homebridge-simplisafe3` package name and platform identity so
an installed test build can reuse existing configuration and accessory pairing.
Install release `.tgz` assets, which contain the compiled plugin. The source
branch itself is not an installable build.

## Checkpoints

1. **1.11.5-jhongturney.1 — legacy camera snapshot replacement.** Remove
   `jpeg-extract` and its deprecated `request` dependency tree. Use Node HTTPS
   with certificate verification, a seven-second total deadline, a 4 MiB response
   limit, and immediate connection cleanup after the first JPEG. Preserve shutter
   privacy checks and the existing LiveKit streaming path.
2. **1.11.5-jhongturney.2 — compatible dependency and security refresh.** Update
   `follow-redirects`, Axios, WebSocket and LiveKit protocol dependencies, and
   compatible transitive security fixes. Recheck authentication and cameras.
3. **1.11.5-jhongturney.3 — supported runtimes and native login command.** Align
   Node requirements and CI with supported Homebridge versions. Replace the
   single-command Oclif dependency with Node's built-in argument parser to remove
   the remaining production security findings.
4. **1.11.5-jhongturney.4 — settings UI helper.** Upgrade
   `@homebridge/plugin-ui-utils` from 0.0.19 to 2.2.7. Verify the real UI process
   protocol and authentication routes with isolated test credentials.
5. **1.11.5-jhongturney.5 — HTTP retry helper.** Update axios-retry from 3.9.1 to
   4.5.0. Preserve retry limits and the v3 policy of not automatically retrying
   HTTP 429; verify real Axios/retry behavior with an isolated response adapter.
6. **1.11.5-jhongturney.6 — camera dependency migration.** Upgrade Werift from
   0.24.4 to 0.26.0. Test encrypted HomeKit forwarding and a real local WebRTC
   connection before field testing both working cameras.
7. **1.11.5-jhongturney.7 — request and polling performance.** Share matching
   in-flight reads and credential refreshes, prevent overlapping sensor/alarm
   polls, and bound API/OAuth HTTP operations with cancellation.
8. **1.11.5-jhongturney.8 — camera cleanup and reconnect behavior.** Cancel timed-out camera
   work and bound reconnect backoff with jitter.

## Follow-up improvements

9. **1.11.5-jhongturney.9 — credential-safe logging.** Redact authentication
   and camera-session secrets at shared log boundaries, preserve diagnostic
   status/code information, and handle split FFmpeg diagnostic lines safely.
10. **1.11.5-jhongturney.10 — combined runtime improvements.** At the user's
    request, group authentication storage/recovery, async callbacks and motion
    timing, coordinated shutdown/disposal, media bounds and legacy stream
    startup into one field-test build. Includes checkpoint 9's log protection.

11. **1.11.5-jhongturney.11 — actionable API failure diagnostics.** Replace the
    ambiguous cooldown warning with operation, elapsed time, HTTP status or
    network error code/category, and the actual cooldown duration. Logging only.

The first eight checkpoints were individually field-tested. The user authorized
combining the remaining follow-up fixes in checkpoint 10; checkpoint 9 has no
separate field-test confirmation yet.
No upstream PR or npm registry release is created by this workflow. Fork release
events are excluded from the upstream npm publishing job.

## First checkpoint validation

- Baseline: 67 existing unit tests passed before editing.
- Updated build: 79 tests passed on Node 22, 24 and 26.
- ESLint, TypeScript checking and whitespace checks passed.
- Production lockfile audit: 11 findings (2 critical, 1 high, 8 moderate) reduced
  to 5 (0 critical, 1 high, 4 moderate). Remaining findings are deferred to the
  dependency checkpoints; the fork is not claimed to be vulnerability-free.
- The release asset includes `npm-shrinkwrap.json` recording the source dependency
  graph. Later clean-install checks found that tarball installations resolved
  allowed newer versions; checkpoint 3 pins the direct runtime dependencies.
  Package installation and plugin registration are checked independently.
- User field test passed: Home app snapshots, live video and audio work on both
  a battery-powered outdoor camera and a plugged-in indoor camera after enabling
  camera support. Exact camera models/provider paths were not supplied; do not
  infer either from their power source. Shutter privacy, notifications, alarm
  controls and sensor updates have not been separately confirmed.

## Second checkpoint validation

- Updated only Axios 1.20.0 → 1.21.0, ws 8.21.0 → 8.22.1,
  @livekit/protocol 1.52.1 → 1.53.4, follow-redirects 1.16.1 → 1.16.2,
  and @babel/runtime 7.17.9 → 7.29.13. No packages were added or removed.
- No application source changes; camera implementation, FFmpeg and Werift stay
  at the first checkpoint's tested versions.
- All 79 tests passed on Node 22, 24 and 26; lint and type checks passed.
- Production audit reduced from 5 findings to 3 moderate findings, all in the
  Oclif/minimatch CLI dependency chain. No high or critical production findings.
- User field test passed: "Everything still working after the update."

## Third checkpoint validation

- Replace Oclif's single-command CLI framework with Node's native argument
  parser. Preserve `login`, `-d`/`--homebridgeDir`, help, version and storage-path
  defaults. No runtime matcher overrides are needed.
- Successful CLI login stores credentials through the existing auth manager and
  ends its background refresh timer. It reports success without printing tokens.
- Require Node 22.12+ within 22.x, 24.x or 26.x; Homebridge 1.11.4+ within 1.x or
  2.5+ within 2.x. Node 18 and 20 are no longer supported by this fork.
- Match Node typings to Node 22 and update the Homebridge development host to
  2.5.0. Expand CI to five supported Node/Homebridge combinations, including
  real host registration and camera-controller setup checks. Update CI actions.
- Camera implementation, UI login and polling stay unchanged. Pin direct runtime
  dependencies to the versions resolved by clean checkpoint 2 installs, including
  FFmpeg 2.2.2, Werift 0.24.4 and LiveKit protocol 1.53.4. This corrects the earlier
  assumption that simply including the source shrinkwrap pinned tarball installs.
  Indirect dependency resolution can still depend on the host installation.
- All 90 tests pass on Node 22.12.0, 24 and 26; lint and type checks pass.
- Both the source lockfile and a clean installed release package audit with zero
  production findings. The clean production installation contains 84 packages,
  compared with 121 at checkpoint 2.
- User field test passed: "everything still works as expected".

## Fourth checkpoint validation

- Only the UI helper's direct version changes, from 0.0.19 to 2.2.7. No
  application JavaScript changes; browser markup, UI routes, camera code,
  authentication manager, CLI and polling remain the same.
- New integration tests start the real UI server as Homebridge does, using IPC,
  temporary storage and an isolated fake token endpoint with network guards.
- Verify saved credentials remain unchanged on opening settings, missing
  credentials are detected, authorization URLs and redirect parsing work, test
  token exchanges persist correctly, failed exchanges preserve credentials, and
  the UI process exits when the settings connection closes even with a token
  refresh timer active.
- All 94 tests pass on Node 22.12.0, 24 and 26; production lockfile audit remains
  at zero findings. Lint and type checks pass.
- User field test passed: "everything still works". Informational UI log entries
  `Incoming Request: /credentialsExist`, `/getCodeVerifier`, and `/getSSAuthURL`
  were observed. They are emitted unconditionally by the UI helper when settings
  initializes and do not represent cloud requests, token refreshes or errors.
  The helper exposes no logging switch for these lines; leave them unchanged.

## Fifth checkpoint validation

- Only axios-retry's locked version changes, 3.9.1 → 4.5.0. Configured retry
  limits remain two for the API and three for OAuth.
- V4 adds automatic HTTP 429 retries by default. Explicitly exclude these on
  both clients to preserve the previous policy and avoid repeating rate-limited
  requests. Retryable server responses now honor the library's Retry-After delay.
- Add eleven integration tests using the actual Axios/retry stack with fake
  responses and network guards: successful/exhausted retries, authorization
  headers, non-repeated state-changing POSTs after server errors, 401/403/429,
  existing block handling, token refresh persistence, and Retry-After scheduling.
- All 105 tests pass on Node 22.12.0, 24 and 26; lint and type checks pass.
  Production lockfile audit remains at zero findings.
- Camera implementation, UI helper and UI request logging remain unchanged.
- User field test passed: "Yep, everything still works".

## Sixth checkpoint validation

- Update Werift 0.24.4 → 0.26.0 and its required Mediabunny dependency
  1.60.0 → 1.65.2 in the source lockfile; remove 27 no-longer-needed locked
  package entries. All other retained versions stay unchanged.
- No application code changes. Test real SRTP encryption/decryption of the
  plugin's video forwarding, multi-frame Opus repacketization and sequence-number
  rollover with HomeKit-format keys.
- A local WebRTC integration test uses the actual LiveKit camera adapter and
  real ICE, DTLS and SRTP to receive H.264 and Opus RTP payloads. Both peers,
  candidate addresses and a test STUN responder are restricted to loopback.
- All 109 tests, including the local WebRTC connection, pass on Node 22.12.0,
  24 and 26. Lint/type checks pass; production lockfile audit remains clean.
- CI runs the local WebRTC integration test on all five supported Homebridge /
  Node combinations in addition to the existing suite.
- User field test passed: "Everything still works in the latest testing. Move forward."
- Local tests verify transport, codec negotiation and RTP bytes, not decoded
  picture/audio quality or real SimpliSafe/LiveKit cloud interoperability.

## Seventh checkpoint validation

- Matching user/subscription discovery, subscription details, sensor and lock
  reads share a pending request per API client. Preserve three-second successful
  read caches with monotonic timestamps rather than expiry timers. Distinguish
  sensor force-update flags; explicit refresh bypasses completed cache while
  joining a matching read already underway. Failed requests are not cached.
- Successful alarm/lock commands invalidate read caches. Older pending reads
  cannot overwrite a newer cache entry afterward. Commands and short-lived
  camera-room tokens are never shared by the read cache.
- Credential refresh is shared per authentication-manager instance, including
  scheduled and on-demand callers. Emit/store once per exchange; clear the slot
  on success, failure or timeout. Bound unusual token refresh intervals to avoid
  millisecond loops. Independent managers remain isolated.
- API and OAuth HTTP operations have a 20-second total deadline, including
  connection setup and retry delays. Abort the transport and release deadline
  timers/listeners on every outcome. Preserve existing network-error backoff;
  caller cancellation does not activate it. AppHub camera HTTP/media paths stay
  unchanged in this checkpoint.
- Sensor and alarm polling each skip ticks while their previous poll runs and
  recover on success/failure. Keep the configured sensor cadence and 62-second
  alarm cadence. Sensor polling can restart after the final subscription is
  removed and later re-added. Existing lockout checks are preserved.
- Register retries once on the shared API client. Preserve credential network
  errors without dereferencing a missing HTTP response.
- Controlled tests: twenty matching reads produce one transport request; twenty
  requests with expired credentials use one OAuth exchange. A real local HTTP
  server confirms twenty sensor reads share one request, independent commands
  are delivered separately, and a stalled connection closes on deadline.
- All 144 tests pass on Node 22.12.0, 24 and 26, including the local HTTP and
  WebRTC integration tests. Lint/type checks pass; production audit is clean.
- No dependency versions or camera media code change.
- User field test passed: "Everything continues to work as expected".

## Eighth checkpoint validation

- LiveKit setup has one 30-second deadline including wake and room lookup.
  Closing a source aborts pending AppHub HTTP work, rejects setup promptly,
  and prevents late lookup/negotiation results from opening another connection.
  Individual AppHub HTTP requests also have a 20-second transport deadline.
- Close signalling listeners, ping intervals and peer resources on setup
  failure, timeout and stop. Handle asynchronous peer-close failures. A Stop
  before Start immediately releases a prepared room and its expiry timer.
- Keyframe capture observes its 15-second deadline even during connection
  setup. Snapshot decoding has an eight-second limit, four-MiB output cap and
  bounded diagnostic buffer; terminate stuck/excessive decoder processes.
- Event snapshot fetches, including response bodies, abort after 15 seconds;
  discard unsuccessful response bodies and release deadline timers. Preserve
  the existing 404 polling interval and short HomeKit waits. Clear wait timers
  when background work finishes first. A HomeKit eight-second wait can still
  end before shared background warming finishes; warming remains bounded.
- An active stream supplies snapshot keyframes without opening a second room.
  Remove the obsolete message saying battery cameras are unsupported.
- Event websocket retries use exponential delays with jitter capped at one
  minute. Recover from user lookup and reconnect failures, terminate failed
  connecting sockets, ignore malformed messages and avoid duplicate heartbeat
  timers or simultaneous connection lookups.
- All 162 tests pass on Node 22.12.0, 24 and 26, including real local WebRTC/HTTP
  checks and a real child-process termination check. Lint and type checks pass;
  production audit has zero findings. No dependency versions changed.
- User field test passed: "Everything still works, great".
- All eight planned checkpoints have passed user field testing. Keep checkpoint
  8 as the current tested build. Local fixtures and the user's installation
  cover different cases; neither establishes support for every camera model
  or every possible cloud outage.

## Ninth checkpoint validation

- One shared logger wrapper sanitizes callable logs and level methods at the
  platform, API, authentication manager and accessory boundaries. Reuse wrappers
  and preserve the original logger receiver and log level.
- Error logs retain name, message, code, status and sanitized causes. Do not
  serialize full Axios request/config objects or invoke their toJSON methods.
  Existing diagnostic logging no longer calls error.toJSON before sanitizing.
- Redact recognized token/authorization/password/PKCE/session credential fields,
  JSON bodies, credential-bearing URL parameters, SRTP keys/salts, binary values,
  and common credential text. Produce detached output without changing active
  requests, persisted tokens, HomeKit keys or responses. Bound object traversal
  and handle cycles; avoid getters and custom inspection functions.
- Legacy FFmpeg diagnostics are assembled by line before redaction so split
  chunks do not expose tokens. Suppress oversized (>8192 characters) and
  incomplete final lines. Redact the existing command-line debug log as well.
- UI error logging and CLI error output use the sanitizer. The explicit login
  URL shown by the interactive CLI remains usable; UI authentication responses
  and protocol behavior remain unchanged. Existing informational incoming UI
  request logs remain expected.
- All 178 tests pass on Node 22.12.0, 24 and 26, including local HTTP/WebRTC.
  Sixteen new tests cover real Axios serialization, scheduled OAuth failure,
  platform startup failure, camera preparation keys, logger levels/receivers,
  nested JSON, cycles, custom serializers and split/oversized FFmpeg lines.
  Lint and type checks pass. Production audit has zero findings.
- No dependency versions or camera transport behavior change. Field testing
  pending; checkpoint 8 remains the last user-confirmed build.

## Tenth checkpoint validation

- Credential writes use a private (0600) temporary file, flush it and atomically
  replace the live file. Failed replacement preserves the prior file. Malformed
  files report a recovery message without crashing construction or overwriting
  the original. Validate required token fields before publishing them.
- Add proper-lockfile 4.1.2 for cross-process coordination across updated plugin,
  UI and CLI instances. Lock the entire read/refresh/write transaction, reload
  the newest token under the lock, handle stale locks and cancel lock waiters
  during shutdown. Keep the login challenge consistent if a verifier changes.
  Coordination applies to writers using this updated code and the same storage;
  older plugin processes and unrelated hosts do not participate in the lock.
- Retain credentials on HTTP 429 and generic temporary errors; defer throttled
  refreshes according to Retry-After with 60-second to one-hour bounds. Background
  transient-error retries use 60–300 seconds. Invalidate credentials for explicit
  invalid_grant / unauthorized responses, not every 4xx. Refresh timers do not
  keep a closed UI process alive on their own. OAuth transport deadline stays
  20 seconds; lock acquisition has a separate cancellable 15-second bound.
- Complete snapshot and stream callbacks once, including failed privacy checks,
  cancellation and early process exits. Catch asynchronous lock-event failures.
  Camera and motion-sensor reset timers restart after the most recent event,
  preserving their five- and ten-second quiet periods respectively.
- Track owned accessory listeners, timers and polling subscriptions. Platform
  shutdown and actual accessory removal dispose owned resources. Cancel API and
  OAuth transport work, reconnect/polling timers, prepared and active camera
  sessions, event-image downloads and decoders. Prevent late operations from
  restarting timers, discovery or camera work. Leave other listeners intact.
- Event snapshots have a streaming four-MiB cap as well as their 15-second time
  limit. H.264 collection allows eight MiB per access unit/fragment, 8192 parts
  and 64-KiB parameter sets; discard oversized/incomplete units and recover on
  a subsequent valid keyframe. Existing codec negotiation and forwarding remain.
- Legacy FFmpeg startup waits for progress reporting a video frame rather than
  arbitrary stderr text. Bound hostname lookup and startup separately to 20
  seconds, report failure once, and stop abandoned processes. This is a startup
  bound, not a duration limit on active viewing. LiveKit startup remains unchanged.
- All 218 tests pass on Node 22.12.0, 24 and 26; lint/type checks pass. Forty new
  checks include actual two-process token rotation, stale-lock recovery, interrupted
  writes, shutdown HTTP cancellation, callbacks/events, media caps and startup.
  Production audit has zero findings. Other dependency versions are unchanged.
- Field testing pending. Checkpoint 8 remains the last explicitly confirmed
  user-tested version. This combined build includes checkpoint 9's logging fixes.

## Eleventh checkpoint validation

- Replace the existing two ambiguous SSAPI cooldown warning sites: HTTP 403 and
  failures without an HTTP response. Identify HTTP 403, timeout, DNS, TLS,
  connection failures and unclassified request errors without guessing that a
  missing response proves rate limiting or invalid credentials.
- Include a static operation label and elapsed HTTP-operation time, including
  retries. Report the actual current cooldown (for example 60 or 120 seconds).
  The time does not include a preceding OAuth refresh. The duration indicates
  eligibility for a later request, not a promise to send a request at that time.
- Use static labels for current routes and a generic label for unknown routes.
  Never log raw URLs, account/device IDs, headers, request or response bodies,
  arbitrary error messages, statusText or request config in these diagnostics.
- Keep existing retries, deadlines, thrown errors and cooldown behavior. Do not
  add new warnings for other HTTP statuses, successful requests, skipped requests
  during cooldown, or caller/shutdown cancellation. Remove redundant 403 debug
  output. Realtime websocket connection messages remain unchanged.
- All 229 tests pass on Node 22.12.0, 24 and 26. Eleven added checks cover real
  Axios 403/network failures, total deadline expiration, escalating cooldowns,
  cancellation, operation labels, redaction and unchanged quiet paths.
  Lint/type checks pass; production audit is clean. No dependencies change.
- Field testing pending; checkpoint 10 has no separate all-working confirmation.

## Current status

The original eight-stage sequence is complete and field-tested. The requested
follow-up runtime fixes are included in checkpoint 10. Checkpoint 11 adds the
requested API diagnostics and includes those runtime changes; field testing is
pending. Lower-priority build-tool/Docker-detection maintenance and camera
CPU profiling remain optional. HKSV is outside this sequence. Upstream submission
and npm publication remain outside this testing workflow.

## Field checks

After installing the release asset and restarting Homebridge:

- Confirm the fork version in the installed package and plugin startup logs.
- Check ordinary arm/disarm operation and sensor updates.
- For legacy SimpliCam / Video Doorbell Pro cameras, check fresh Home app
  thumbnails, live video and audio, and normal motion/doorbell notifications.
- Check that a closed privacy shutter still returns the privacy image without
  opening the shutter.
- If using LiveKit cameras, verify thumbnails, live video/audio and notifications
  still work; check idle-camera startup and close/reopen playback as well.
- Report the camera model, Node/Homebridge versions and relevant errors, with
  credentials and tokens removed.

## Rollback

From `hb-shell`, in `/var/lib/homebridge`, run:

```sh
npm install --save-exact homebridge-simplisafe3@1.11.4
```

Then leave the shell and restart Homebridge. Keep the existing plugin
configuration and accessory pairing.
