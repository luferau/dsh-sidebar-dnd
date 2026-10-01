/**
 * dsh-sidebar-dnd — browser half.
 *
 * Adds drag-and-drop to the rows of the BUILT-IN Workspace Files sidebar
 * (`@deepseek-ai/dsh-client-ui-sidebar-files`), which ships without it. A
 * dropped row inserts a DSH-native `@file` mention into the chat composer.
 *
 * WHY DOM AND NOT A SLOT: the shipped package declares no per-row extension
 * seat — its README lists "no drag-and-drop" as a known limitation, and the
 * only nearby seat (`sidebar.right.tab.files.actions`) is a header action
 * list, not a row cell. So this plugin attaches to the tree's own stable
 * `data-files-*` attributes instead of forking the component.
 *
 * The mention spelling is a byte-for-byte port of DSH's own
 * `formatFileMention` (`@deepseek-ai/dsh-file-reference`), so a dropped
 * mention is indistinguishable from one produced by `@` completion and
 * resolves through the same workspace-root-relative grammar.
 *
 * Self-contained: no imports, no build step, no host services.
 */
;(function () {
  'use strict'

  /** Registration id — must equal the package name. */
  var PLUGIN_ID = 'dsh-sidebar-dnd'
  /** Locale namespace owned by this plugin. */
  var NS = 'sidebar-dnd'
  /** Marker class while a row is being dragged. */
  var DRAG_CLASS = 'dsf-dnd-dragging'
  /** Marker class on the composer while a row hovers it. */
  var OVER_CLASS = 'dsf-dnd-over'
  /** Marks a row already processed, so re-marking is idempotent. */
  var READY = 'data-dsf-ready'
  /** Stable row selector published by the shipped sidebar-files package. */
  var ROW_SELECTOR = '[data-files-entry][data-files-path]'
  /** Container carrying the workspace root as `data-files-root`. */
  var TREE_SELECTOR = '[data-files-state="tree"][data-files-root]'

  /** Dictionary; `zh` is the key-set source of truth. */
  var dict = {
    dragHint: {
      zh: '拖到输入框即可引用',
      en: 'Drag into the composer to reference'
    }
  }

  /** Flattened locale tables handed to `locale.register`. */
  var zh = {}
  var en = {}
  for (var key in dict) {
    zh[key] = dict[key].zh
    en[key] = dict[key].en
  }

  /* ------------------------------------------------------------------ *
   * Pure logic — exported for tests, no DOM at module scope.
   * ------------------------------------------------------------------ */

  /**
   * Normalize one absolute path to forward slashes without a trailing slash.
   * @param value - absolute path in either separator style.
   * @returns normalized path.
   */
  function normalize(value) {
    return String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /**
   * Express an absolute row path relative to the workspace root.
   *
   * `data-files-path` is absolute (the sidebar resolves it from the session
   * root), while `@file` mentions resolve from that same root — so the prefix
   * must come off, not stay. A path outside the root is returned unchanged
   * rather than mangled, because an absolute mention is still valid grammar.
   * @param absPath - the row's absolute path.
   * @param root - the tree's workspace root.
   * @returns root-relative path, or the normalized absolute path.
   */
  function relativize(absPath, root) {
    var path = normalize(absPath)
    var base = normalize(root)
    if (base === '') return path
    if (path === base) return ''
    // Windows drive letters are case-insensitive; POSIX paths are not.
    var isWin = /^[A-Za-z]:\//.test(path) || /^[A-Za-z]:\//.test(base)
    var comparable = isWin ? path.toLowerCase() : path
    var bound = isWin ? base.toLowerCase() : base
    if (comparable.slice(0, bound.length + 1) === bound + '/') {
      return path.slice(base.length + 1)
    }
    return path
  }

  /**
   * Format a path as DSH prompt text — a port of `formatFileMention`.
   *
   * A directory gains a trailing slash; a path containing whitespace uses the
   * quoted grammar; a path the grammar cannot represent safely yields `null`.
   * @param path - root-relative path (or absolute).
   * @param isDirectory - whether the row is a directory.
   * @returns the mention text, or null when unrepresentable.
   */
  function formatMention(path, isDirectory) {
    if (isDirectory) {
      var dir = path.replace(/\/+$/, '') + '/'
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(dir)) return null
      return /\s/u.test(dir) ? '@"' + dir : '@' + dir
    }
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return null
    return /\s/u.test(path) ? '@"' + path + '"' : '@' + path
  }

  /**
   * Compute the value and caret for inserting a mention at a selection.
   *
   * The mention is padded so it stays a standalone token — an `@` inside
   * another token does not trigger completion, and the model guidance keys off
   * whitespace-delimited paths.
   * @param text - current composer value.
   * @param start - selection start.
   * @param end - selection end.
   * @param mention - the mention to insert.
   * @returns the new value and the caret offset after the insertion.
   */
  function insertText(text, start, end, mention) {
    var before = text.slice(0, start)
    var after = text.slice(end)
    var padBefore = before === '' || /\s$/.test(before) ? '' : ' '
    var padAfter = after === '' || /^\s/.test(after) ? '' : ' '
    var snippet = padBefore + mention + padAfter
    return { value: before + snippet + after, caret: start + snippet.length }
  }

  /* ------------------------------------------------------------------ *
   * DOM layer — only runs in a browser.
   * ------------------------------------------------------------------ */

  if (typeof document === 'undefined') return

  /** The session's workspace root, refreshed on each mark pass. */
  var rootPath = ''
  /** Localized row tooltip; English until the dictionary resolves. */
  var hint = en.dragHint
  /** The injected stylesheet, removed on teardown. */
  var styleElement = null
  /** Mention carried by the in-flight drag, or null when it is not ours. */
  var dragMention = null
  /** Whether the in-flight drag started from a sidebar row. */
  var dragging = false
  /** Rows already processed. */
  var markedRows = new WeakSet()
  /** Pending mark pass, so mutation bursts coalesce. */
  var queued = false

  /**
   * Find the chat composer.
   *
   * The composer is not slot-addressable from a UI-only plugin, so it is
   * identified structurally: an existing text selection wins, otherwise the
   * tallest visible textarea. The height rule keeps this correct even while
   * the sidebar's own controls hold focus.
   * @returns the composer, or null.
   */
  function findComposer() {
    var active = document.activeElement
    if (active && active.tagName === 'TEXTAREA') return active
    var all = document.querySelectorAll('textarea')
    var best = null
    var bestHeight = 0
    for (var i = 0; i < all.length; i++) {
      var rect = all[i].getBoundingClientRect()
      if (rect.height > bestHeight) {
        bestHeight = rect.height
        best = all[i]
      }
    }
    return best
  }

  /**
   * Whether a viewport point lies on the composer, with a small slop margin.
   * @param x - viewport x.
   * @param y - viewport y.
   * @returns whether the point is a valid drop target.
   */
  function overComposer(x, y) {
    var composer = findComposer()
    if (!composer) return false
    var rect = composer.getBoundingClientRect()
    var margin = 24
    return (
      x >= rect.left - margin &&
      x <= rect.right + margin &&
      y >= rect.top - margin &&
      y <= rect.bottom + margin
    )
  }

  /**
   * Insert a mention at the caret, keeping React's value tracker in sync.
   * @param mention - mention text to insert.
   * @returns whether the composer accepted it.
   */
  function insertMention(mention) {
    var composer = findComposer()
    if (!composer) return false
    var start =
      typeof composer.selectionStart === 'number' ? composer.selectionStart : composer.value.length
    var end =
      typeof composer.selectionEnd === 'number' ? composer.selectionEnd : composer.value.length
    var next = insertText(composer.value, start, end, mention)

    // Assign through the prototype setter so React's onChange still fires; a
    // plain `element.value =` assignment is swallowed by its value tracker.
    var proto = Object.getPrototypeOf(composer)
    var descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
    if (descriptor && descriptor.set) descriptor.set.call(composer, next.value)
    else composer.value = next.value

    composer.dispatchEvent(new Event('input', { bubbles: true }))

    try {
      composer.focus()
      composer.setSelectionRange(next.caret, next.caret)
    } catch (error) {
      /* A detached or non-textarea target has no selection; the text is in. */
    }
    return true
  }

  /**
   * Outline the composer while a row hovers it.
   * @param on - whether the hint is visible.
   */
  function setDropHint(on) {
    var composer = findComposer()
    if (composer) composer.classList.toggle(OVER_CLASS, on)
  }

  /** Clear every transient drag style. */
  function clearDragVisuals() {
    setDropHint(false)
    var lit = document.querySelectorAll('.' + DRAG_CLASS)
    for (var i = 0; i < lit.length; i++) lit[i].classList.remove(DRAG_CLASS)
  }

  /**
   * Give every sidebar row the draggable attribute, idempotently.
   * @param hint - localized tooltip for a draggable row.
   */
  function markRows(hint) {
    var tree = document.querySelector(TREE_SELECTOR)
    if (!tree) return
    rootPath = tree.getAttribute('data-files-root') || ''
    var rows = tree.querySelectorAll(ROW_SELECTOR)
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (markedRows.has(row)) continue
      markedRows.add(row)
      row.setAttribute('draggable', 'true')
      row.setAttribute(READY, '')
      if (hint) row.setAttribute('title', hint)
    }
  }

  /**
   * Coalesce mutation bursts into one mark pass.
   * @param hint - localized tooltip for a draggable row.
   */
  function scheduleMark(hint) {
    if (queued) return
    queued = true
    queueMicrotask(function () {
      queued = false
      // Never re-mark mid-drag: React can re-render rows under the pointer.
      if (dragging) return
      markRows(hint)
    })
  }

  /**
   * Register the plugin's dictionary and resolve the row tooltip.
   *
   * The returned disposer is registered through `ctx.effect` when available;
   * a context without that seam still gets the tooltip.
   * @param ctx - client context.
   */
  function registerDictionary(ctx) {
    if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return
    var register = function () {
      return ctx.locale.register(NS, { zh: zh, en: en })
    }
    if (typeof ctx.effect === 'function') ctx.effect(register, 'sidebar-dnd: dictionaries')
    else register()

    if (typeof ctx.locale.bind !== 'function') return
    try {
      hint = ctx.locale.bind(NS)('dragHint')
    } catch (error) {
      /* An unbound namespace keeps the dictionary's English text. */
    }
  }

  /**
   * Inject the plugin's stylesheet once.
   * @returns the injected style element.
   */
  function installStyle() {
    styleElement = document.createElement('style')
    styleElement.textContent =
      '[data-files-entry][draggable="true"]{cursor:grab;}' +
      '.' + DRAG_CLASS + '{opacity:.55;}' +
      '.' + OVER_CLASS + '{outline:2px solid var(--dsh-accent,#4c8dff);outline-offset:-2px;}'
    document.head.appendChild(styleElement)
    return styleElement
  }

  /**
   * Attach the document-level drag lifecycle listeners.
   * @returns nothing.
   */
  function wireDragHandlers() {
    document.addEventListener(
      'dragstart',
      function (event) {
        var node = event.target
        var row = node && node.closest ? node.closest(ROW_SELECTOR) : null
        if (!row) return
        var isDirectory = row.getAttribute('data-files-entry') === 'directory'
        var rel = relativize(row.getAttribute('data-files-path') || '', rootPath)
        if (rel === '') return
        var mention = formatMention(rel, isDirectory)
        if (mention === null) return
        dragMention = mention
        dragging = true
        row.classList.add(DRAG_CLASS)
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData('text/plain', mention)
        }
      },
      true
    )

    document.addEventListener('dragend', function () {
      dragging = false
      dragMention = null
      clearDragVisuals()
    })

    document.addEventListener(
      'dragover',
      function (event) {
        if (!dragging) return
        var over = overComposer(event.clientX, event.clientY)
        if (event.dataTransfer) event.dataTransfer.dropEffect = over ? 'copy' : 'none'
        if (over) event.preventDefault()
        setDropHint(over)
      },
      true
    )

    document.addEventListener(
      'drop',
      function (event) {
        if (!dragging) return
        var mention = dragMention
        dragging = false
        dragMention = null
        clearDragVisuals()
        if (!overComposer(event.clientX, event.clientY)) return
        // Claim the drop before any other consumer sees it.
        event.preventDefault()
        event.stopPropagation()
        if (mention) insertMention(mention)
      },
      true
    )
  }

  /**
   * Mark current and future sidebar rows draggable, and register teardown.
   *
   * The observer watches `childList` only, so this plugin's own attribute
   * writes never re-trigger it.
   * @param ctx - client context.
   * @returns the observer.
   */
  function observeRows(ctx) {
    var observer = new MutationObserver(function () {
      scheduleMark(hint)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    markRows(hint)

    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(function () {
        return function () {
          observer.disconnect()
          clearDragVisuals()
        }
      }, 'sidebar-dnd: row observers')
    }
    return observer
  }

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory: function () {
      /**
       * Guarded plugin body. The client loader treats a THROW here as a failed
       * entry, which aborts the whole Web boot audit — a drag-and-drop nicety
       * must never be able to do that. Every phase is therefore isolated, and
       * a failure degrades to "no drag support" instead of "no app".
       * @param ctx - client context.
       */
      function safeApply(ctx) {
        var steps = [
          function () {
            return registerDictionary(ctx)
          },
          function () {
            return installStyle()
          },
          function () {
            return wireDragHandlers()
          },
          function () {
            return observeRows(ctx)
          }
        ]
        for (var i = 0; i < steps.length; i++) {
          try {
            steps[i]()
          } catch (error) {
            // One broken phase must not stop the others, and must not throw
            // out of apply().
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('sidebar-dnd: phase ' + i + ' failed', error)
            }
          }
        }
      }

      var exports = { name: PLUGIN_ID, inject: ['locale'], apply: safeApply }
      exports.__test = {
        normalize: normalize,
        relativize: relativize,
        formatMention: formatMention,
        insertText: insertText,
        findComposer: findComposer,
        overComposer: overComposer,
        insertMention: insertMention,
        markRows: markRows,
        getRoot: function () {
          return rootPath
        }
      }
      Object.defineProperty(exports, '__esModule', { value: true })
      return exports
    }
  })
})()
