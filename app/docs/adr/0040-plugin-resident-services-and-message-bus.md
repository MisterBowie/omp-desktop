# ADR 0040: Resident plugin services and the inter-plugin message bus

- Status: Accepted
- Date: 2026-07-31
- Related: [Plugin lifecycle](../spec/07-plugins/05-plugin-lifecycle.md),
  [Plugin IPC and host services](../spec/07-plugins/12-plugin-ipc-and-host-services.md),
  [ADR 0008](0008-plugin-runtime-isolation-target.md)

## Context

Two roadmap items were blocked on the same missing pieces.

**Background services.** A plugin could only do work when something called into
it: a command, a tool, or `onLoad`. A watcher, a poller, or a sync worker had no
supported home. Nothing stopped a plugin from starting a timer inside `onLoad`,
but the host had no idea it existed, could not report it, and could not restart
it — a crash simply lost the work silently.

**Inter-plugin messaging.** `pi.events.on` / `off` existed in the SDK as no-ops.
Plugins that wanted to cooperate had only the filesystem, which is invisible to
the host and unbounded.

Both need the same two things: a way for the host to know a plugin is doing
something, and a parent→child push channel. The plugin wire protocol had only
request/response frames (`init` / `call` / `res` / `log`) — every message
originated in the child.

## Decision

### One new frame

The broker gains a one-way parent→child frame:

```text
{ t: "event", event, ... }   // no reply, no backpressure
```

`bus.message` is its first user. The same frame finally implements
`pi.events.on` / `off`, which now sees the raw event stream.

### Resident services

1. A service is **declared** (`contributes.services`, at most 4 per plugin) and
   gated on `background.service`. `pi.services.register({ id, start, stop })` in
   the child is local bookkeeping only — the manifest already said the service
   exists, so registration cannot create one.
2. The **broker decides when it runs**: `start` after `onLoad` completes (5s
   budget), `stop` before `onUnload`. A service is therefore never live outside
   the window in which the plugin still has its API. `start` is idempotent inside
   one process.
3. A service lives in the plugin's `utilityProcess` (ADR 0008), so a crash takes
   it down with the process. The supervisor restarts the **whole plugin**:
   backoff 1s, 2s, 4s, 8s, 16s capped at 30s; at most 5 attempts; a process that
   stays up 60s is healthy and resets the counter. `autoRestart: false` opts out.
4. After the last attempt the plugin stays `failed`. Per-service state
   (`starting` | `running` | `stopped` | `failed`) plus the restart count is read
   over `plugin/services`, rendered as chips on the Plugins page, and audited as
   `plugin.service.*`.
5. Manual enable / disable outranks the supervisor: an explicit user action
   cancels the pending timer and clears the attempt counter.

### Message bus

1. Traffic is **declared in the manifest**: `contributes.bus.publish` lists
   concrete topics, `contributes.bus.subscribe` lists patterns. The permissions
   `bus.publish` / `bus.subscribe` are necessary but not sufficient — a granted
   permission with no declaration routes nothing.
2. Topics are dot-separated segments (`[a-zA-Z0-9][a-zA-Z0-9_-]*`, ≤8 segments,
   ≤128 chars). `*` matches one segment; `**` matches one or more trailing
   segments and may appear only as the final segment.
3. **Routing lives in the broker.** A message carries `topic`, `from`, `payload`,
   and a host-assigned `at`. The publisher is excluded from its own fan-out.
   Delivery is fire-and-forget, so a wedged subscriber cannot stall a publisher.
4. Caps: 64KB per payload, 16 subscriptions per plugin, 100 publishes per rolling
   10s window; over-cap calls fail `LIMIT_EXCEEDED` / `RATE_LIMITED` and are
   audited with the topic.
5. A payload is **data, never capability**. Receiving a message grants the
   subscriber nothing it did not already hold, so no permission can be laundered
   across the bus.

## Consequences

- A background worker is now a first-class, visible, supervised thing: the user
  sees it running, sees it restart, and sees it give up.
- Restarting the plugin rather than the service is coarse — a crash re-runs
  `onLoad` — but it is the only honest unit, because the crash already destroyed
  the process the service lived in.
- The 5-attempt ceiling means a genuinely broken service stops retrying. That is
  the intent: a visible `failed` chip beats an invisible crash loop burning CPU.
- Declared topics make plugin-to-plugin coupling reviewable, and let the host
  reject undeclared traffic without knowing anything about payload semantics.
- Because the publisher is excluded from its own fan-out, a plugin cannot use the
  bus as an internal event emitter — it must use ordinary function calls, which
  is what it should have done anyway.
- Any plugin holding `bus.subscribe` and a matching pattern sees a topic, so a
  topic is effectively public within the app. Secrets do not belong on it.

## Alternatives

### Let plugins start their own timers and call it a service

Rejected. That is the status quo. The host cannot report, stop, or restart work
it does not know about, and the user cannot see it at all.

### Restart the service in place instead of the plugin

Rejected. The service runs inside the plugin's process; if it crashed the
process, there is no in-place to restart into. A separate process per service
would multiply ADR 0008's isolation cost for no gain at this scale.

### Unlimited restarts

Rejected. A crash loop with backoff still burns CPU forever and hides the
failure behind a chip that flickers between `starting` and `failed`.

### An open pub/sub with permissions only

Rejected. `bus.publish` would then mean "talk to every plugin about anything",
which is unreviewable. Declared topics keep the manifest a complete statement of
what a plugin says and hears.

### Direct plugin-to-plugin RPC

Rejected. It creates hard dependencies between independently installable,
independently versioned plugins, and it hands one plugin a handle on another.
Topic pub/sub keeps both sides ignorant of each other.
