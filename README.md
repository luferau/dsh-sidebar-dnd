# dsh-sidebar-dnd

Drag-and-drop `@file` references from the **built-in** Workspace Files sidebar
into the chat composer.

The shipped `@deepseek-ai/dsh-client-ui-sidebar-files` panel is listing-only —
its own README lists "no drag-and-drop" as a known limitation. This plugin adds
it to the panel you already use, without forking the package.

## Install

```sh
dsh plugin --profile web add dsh-sidebar-dnd
# then restart: dsh web   and hard-refresh the page
```

## What it does

- Every file/folder row in the Workspace Files tree becomes draggable.
- Dragging a row over the composer outlines the composer as a drop target.
- Dropping inserts a **DSH-native `@file` mention** at the caret, padded so it
  stays a standalone token.
- Dropping anywhere else does nothing — the plugin never swallows a drop it
  does not own.

## Why a mention and not a custom tag

The mention spelling is a byte-for-byte port of DSH's own `formatFileMention`
from `@deepseek-ai/dsh-file-reference`, so a dropped reference is
indistinguishable from one produced by `@` completion and resolves through the
same grammar the model is already told about:

| Row | Inserted text |
|---|---|
| `src/App.tsx` | `@src/App.tsx` |
| `src/my file.ts` | `@"src/my file.ts"` |
| `src` (directory) | `@src/` |

A path the grammar cannot represent safely (control characters, embedded
quotes) is not inserted at all rather than inserted broken.

## Install

From npm:

```sh
dsh plugin --profile web add dsh-sidebar-dnd
```

From a checkout of this directory:

```sh
dsh plugin --profile web add "<absolute path to this directory>"
```

Either way, restart `dsh web` and hard-refresh the page. The restart is
required: `dsh plugin` writes the bundle list into the profile manifest, and the
profile composes it on the next start. Note that removing the dependency from
`~/.dsh/profiles/web/package.json` also removes the bundle reference — re-run
the `add` command to restore both.

## Requirements

- DeepSeek Harness with a Web profile (`dsh web`), version `0.2.0-rc.2` or later.
- The built-in Workspace Files sidebar (`@deepseek-ai/dsh-client-ui-sidebar-files`),
  which ships in the Web profile. This plugin hooks its rows; without that
  package it loads and does nothing.
- No build step, no runtime dependencies — the browser bundle is committed.

## Publishing

```sh
npm run check        # syntax-check both halves
npm test             # 20 unit tests
npm pack --dry-run   # inspect the 6 shipped files
npm publish          # prepack re-runs check + test
```

Before publishing, set `author`, `repository`, and `homepage` in
`package.json` to your own values. Compatibility is declared through
`peerDependencies` rather than `engines`, because DSH rejects an install whose
declared DSH peers are unsatisfied — a too-narrow peer range would block
installation outright instead of merely warning.

## Why it is DOM-based

The sidebar package declares **no per-row extension seat**. Its only nearby
seat, `sidebar.right.tab.files.actions`, is a header action list, not a row
cell — so a row-level hook cannot be expressed as a slot registration.

Instead this plugin attaches to the tree's own stable DOM contract, which the
shipped component publishes deliberately:

| Attribute | Meaning |
|---|---|
| `data-files-state="tree"` | the tree container is live |
| `data-files-root` | workspace root, used to relativize row paths |
| `data-files-entry="file" \| "directory" \| "other"` | row kind |
| `data-files-path` | the row's **absolute** path |

Rows are marked draggable by a `MutationObserver` on `childList` only, so the
plugin's own attribute writes never re-trigger it. Marking is idempotent and is
skipped while a drag is in flight, because React can re-render rows under the
pointer.

## Two rules that matter if you fork this

Both were learned the hard way — each one on its own took the whole Web UI down.

1. **A client plugin MUST export `inject` for every service it touches.** Cordis
   does not merely order activation by `inject`; it *gates property access*.
   Reading `ctx.locale` without declaring `inject: ['locale']` throws
   `cannot get property "locale" without inject`. That throw happens inside
   `apply()`, so the entry fails — and a failed entry aborts the entire Web boot
   audit, so the app does not start at all.
2. **Never let `apply()` throw.** `safeApply` runs the plugin as four
   independently guarded phases, so a failure degrades to "no drag support"
   instead of "no app". A cosmetic feature must not be able to brick boot.

## Known limitations

- **The composer is found structurally, not by slot.** It is not
  slot-addressable from a UI-only plugin, so it is identified as the focused
  textarea, else the tallest textarea on the page. A future DSH composer that
  is not a `<textarea>` (for example a contenteditable) would break insertion
  while leaving the drawer and row marking intact.
- **No reference chips.** DSH's own chip rendering is driven by its `@`
  completion path, so the inserted mention appears as text. The text is the
  authoritative reference either way.
- **Rows the tree renders as `other` are draggable too**, but naming one the
  prompt grammar rejects inserts nothing.
- **Not wired into the Right Sidebar's own preview panel**: this plugin only
  adds drag-out, not drag-in.

## Tests

```sh
npm test
```

The suite installs a minimal DOM stub, imports the real bundle, runs the real
`apply()`, and drives the real `dragstart`/`dragover`/`drop` handlers with
synthetic events — asserting the resulting composer value, the single
prototype-setter write React's tracker needs, and the cleared drag state.

A real-browser pass (headless Chrome over CDP) additionally confirms, against a
running `dsh web`: the entry activates with no console errors, rows get
`draggable="true"` and the tooltip, `dragstart` carries `@"src/my file.ts"` in
`dataTransfer`, dropping on the composer yields `please review @"src/my file.ts"`
with exactly one `input` event, a directory row yields `@src/`, and a drop away
from the composer inserts nothing.

