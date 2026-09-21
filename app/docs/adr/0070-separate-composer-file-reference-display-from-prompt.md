# ADR 0070: Separate Composer File-Reference Display from Prompt Serialization

- Status: Accepted for implementation
- Date: 2026-08-10
- Deciders: PI-Desktop core
- Related: D124, D197, D209, ADR 0024, ADR 0059

## Context

Workspace autocomplete and clipboard paste both produce canonical file paths
that the agent must receive as plain-text `@` references. Rendering those paths
directly in the controlled composer textarea exposes long workspace paths and,
for pasted files, UUID-backed absolute scratch paths. The paths can wrap across
multiple lines and crowd out the actual task while still being necessary at
dispatch time.

A native textarea cannot render one substring differently from its underlying
value. A shortened textarea value also cannot be expanded by basename lookup:
duplicate leaf names are valid, and scratch files require their exact absolute
paths.

## Decision

1. A completed file selection and each materialized clipboard file become a
   renderer-owned, transient composer reference. The visible textarea keeps
   only the user's ordinary text. Directory autocomplete remains literal so it
   can continue into deeper path segments.
2. Each reference stores its canonical path and a compact leaf label. Workspace
   references keep the complete relative index path; pasted references keep the
   UUID-backed absolute scratch path while displaying the sanitized original
   leaf name returned by `composer/pasteFiles`.
3. The composer renders references as compact removable chips above the
   textarea. A chip persistently shows only its leaf label; its canonical path
   remains available through the tooltip and accessible name. Duplicate labels
   remain separate references with separate canonical paths.
4. Immediately before the existing submit dispatcher runs, the renderer
   appends references in stable addition order and serializes each with the
   existing `formatFileInsert` quoting rules. The resulting prompt remains
   plain text and contains the exact `@relative/path` or `@absolute/path` that
   pi and the agent already consume.
5. Reference-only drafts are sendable. References are appended after visible
   text so slash templates and `/agent-mode`, `/plan-mode`, and `/goal-mode`
   remain recognizable at the start of the draft. Successful local or prompt
   dispatch clears the active editor, while rejected or failed dispatch retains
   it. An accepted prompt also retains a renderer-only, session- and turn-scoped
   snapshot of its pre-serialization text and references until the turn leaves
   the unanswered smart-stop window.
6. Stopping before assistant text, thinking, or a tool row begins removes the
   just-sent user row and restores the structured snapshot. Canonical paths
   return behind their leaf-name chips, never as textarea text. Once a reply
   begins, abort keeps the partial transcript and restores no draft. The
   snapshot is not reconstructed from persisted message content and adds no
   IPC, host RPC, or storage field.
7. References are scoped by durable session id and cleared when their workspace
   changes. Removing a chip removes only the draft reference; scratch bytes keep
   the existing session lifecycle.
8. `ComposerPastedFile.name` is the sanitized original leaf display name. The
   unique UUID storage name is represented by `path`, not duplicated into the
   display label. This is an additive semantic clarification inside the
   existing Electron-only shape; no host protocol or storage schema changes.

## Alternatives considered

- **Insert only the basename into the prompt:** rejected because duplicate
  names and external scratch files would no longer resolve reliably.
- **Overlay shortened text on a transparent textarea:** rejected because the
  displayed and native text lengths diverge, breaking caret, selection,
  wrapping, IME, and accessibility behavior.
- **Replace the textarea with `contenteditable`:** rejected for this focused
  change because it would reopen the complete IME, selection, undo, paste, and
  accessibility contract.
- **Parse serialized `@path` tokens back out of an unanswered user message:**
  rejected because user-authored references and renderer-appended references
  are indistinguishable, and the persisted text no longer carries the original
  display label or duplicate-reference identity.
- **Send provider-specific binary attachments:** rejected because file tools
  already consume the materialized path and the prompt contract remains
  provider-independent plain text.

## Consequences

- Long and UUID-backed paths no longer occupy the visible prompt row.
- Canonical references remain exact in persisted messages and model context.
- The renderer owns transient reference state in addition to textarea text.
- Clipboard storage containment, limits, cleanup, and security boundaries are
  unchanged from ADR 0059.
