# 17. asktool Interactive Questions

## 1. Purpose

`asktool` lets the model pause a turn and ask the user one or more bounded
questions. It is available in Agent, Plan, and Goal mode and is separate from
permission approval: it does not authorize an operation and has no validity
deadline.

## 2. Request shape

The tool accepts a non-empty `questions` array. Each question contains:

- `question`: the prompt text;
- `options`: one or more selectable answer labels;
- `multiSelect`: optional; when true, more than one selectable answer is allowed.
- `allowCustom`: optional, set by the asker rather than the model; `false` when
  the asker can only return one of `options`.

The desktop card adds one extra `Enter another answer` option with a text field
unless the question carries `allowCustom: false`. The model does not need to add
a special free-text choice to the tool arguments.

## 3. Card interaction

Only one question is shown at a time. A small indicator is rendered for every
question and uses three states: unanswered, answered, and skipped. Selecting an
indicator revisits that question. `Next` records an answer when one exists;
otherwise it records a skip. `Skip` explicitly records a skip and advances.
`Decline all` resolves every question as skipped.

There is no timer, countdown, or automatic expiration. The card remains pending
until the user submits or the turn is stopped. If the turn is stopped while a
card is open, the runtime resolves every remaining question as skipped.

## 4. Tool output

The response is the normal tool result returned to the model and persisted with
the tool row. For each question, the content is serialized as:

```text
question text：answer 1、answer 2
```

Multiple questions are separated by `\n---\n`. A skipped or unanswered
question keeps the question text and uses an empty placeholder:

```text
question text：
```

This format is deterministic, preserves question order, and makes multi-select
answers distinguishable without exposing a renderer-only state object to the
model.

## 5. OMP engine

On the OMP engine the questions come from OMP's own `ask` tool, which reaches
the desktop as one RPC `select` dialog per question (each surfaced as a
one-question card) rather than through the desktop tool above. The runtime
appends its own free-text option, `Other (type your own)`, to every such
`select`, and asks for the text in a follow-up `editor` dialog once that option
is picked.

- The card does not list `Other (type your own)`; its own `Enter another
  answer` row stands in for it, and the question carries `allowCustom: true`.
- A typed answer is delivered in two steps: the bridge answers the `select`
  with `Other (type your own)` and answers the runtime's next `editor`/`input`
  dialog of the same run with the text, without showing a second card. The text
  is never given to any other dialog: another question in between, a new run or
  a stop drops it.
- A `select` that does not offer the free-text option (for example one raised
  by an extension) carries `allowCustom: false`, so the card offers no typed
  answer it could not deliver. A typed answer that still arrives for one (for
  example from a remote client) cancels that dialog.
- A free-text `input`/`editor` dialog the desktop has no card for is answered
  `cancelled` at once, so the runtime is never left waiting on it.

Skipping or declining answers the dialog `cancelled`, which the runtime's `ask`
tool treats as the user aborting the turn.
