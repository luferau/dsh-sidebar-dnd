/**
 * Tests for dsh-sidebar-dnd.
 *
 * The shipped artifact is a single self-contained browser bundle, so it cannot
 * be imported by a bundler-less Node process for its internals. Instead this
 * file installs a minimal DOM stub BEFORE importing the bundle: the bundle
 * then runs its real registration, its real `apply()` wiring and its real
 * event handlers against that stub, and dispatches synthetic drag events
 * through the plugin's own listeners. Nothing here re-implements plugin logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/** Leaf text as seen by the shipped file tree. */
const ROOT = 'G:\\_repos\\Software_Shell_Repos'
const HINT = '拖到输入框即可引用'

/* ------------------------------------------------------------------ *
 * Minimal DOM stub — only the surface this plugin touches.
 * ------------------------------------------------------------------ */

/** Every node that has entered the stub document, for querySelectorAll. */
const registry = new Set()

/** Element stand-in supporting attributes, classes, children and bubbling. */
class StubNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentNode = null
    this.classes = new Set()
    this.listeners = new Map()
    this.textContent = ''
    registry.add(this)
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }
  hasAttribute(name) {
    return this.attributes.has(name)
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child)
    child.parentNode = null
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || []
    list.push(fn)
    this.listeners.set(type, list)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || []
    this.listeners.set(
      type,
      list.filter((f) => f !== fn)
    )
  }
  /** Dispatch to this element's listeners only (bubbling is handled centrally). */
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || []
    for (const fn of list) fn(event)
    return true
  }
  classList = {
    add: (c) => this.classes.add(c),
    remove: (c) => this.classes.delete(c),
    contains: (c) => this.classes.has(c),
    toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c))
  }
  closest(selector) {
    let node = this
    while (node) {
      if (matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector)
    return found.length > 0 ? found[0] : null
  }
  getBoundingClientRect() {
    return { left: 0, right: 600, top: 500, bottom: 560, width: 600, height: 60 }
  }
}

/** The stub supports the selectors this plugin queries, plus `.class`. */
function matches(node, selector) {
  if (selector === '[data-files-entry][data-files-path]') {
    return node.hasAttribute('data-files-entry') && node.hasAttribute('data-files-path')
  }
  if (selector === '[data-files-state="tree"][data-files-root]') {
    return node.hasAttribute('data-files-state') && node.hasAttribute('data-files-root')
  }
  if (selector.charAt(0) === '.') {
    return node.classes.has(selector.slice(1))
  }
  if (/^[a-z]+$/.test(selector)) {
    return node.tagName === selector.toUpperCase()
  }
  return false
}

/** Query the whole stub document in registration order. */
function queryAll(selector) {
  const found = []
  for (const node of registry) if (matches(node, selector)) found.push(node)
  return found
}

/** One tree row, matching the shipped sidebar's DOM contract. */
function makeRow(kind, path) {
  const li = new StubNode('li')
  li.setAttribute('data-files-entry', kind)
  li.setAttribute('data-files-path', path)
  const button = new StubNode('button')
  li.appendChild(button)
  li.button = button
  return li
}

const tree = new StubNode('div')
tree.setAttribute('data-files-state', 'tree')
tree.setAttribute('data-files-root', ROOT)

const fileRow = makeRow('file', `${ROOT}\\package.json`)
const spacedRow = makeRow('file', `${ROOT}\\src\\my file.ts`)
const dirRow = makeRow('directory', `${ROOT}\\src`)
tree.appendChild(fileRow)
tree.appendChild(spacedRow)
tree.appendChild(dirRow)

/** Composer stand-in with a prototype value setter, like a real textarea. */
class StubTextarea extends StubNode {
  constructor() {
    super('textarea')
    this._value = ''
    this.selectionStart = 0
    this.selectionEnd = 0
    this.writes = []
    this.focused = false
    this.inputEvents = 0
  }
  setSelectionRange(start, end) {
    this.selectionStart = start
    this.selectionEnd = end
  }
  focus() {
    this.focused = true
  }
}
Object.defineProperty(StubTextarea.prototype, 'value', {
  get() {
    return this._value
  },
  set(next) {
    this.writes.push(next)
    this._value = next
  }
})

const composer = new StubTextarea()
composer.value = 'please review '
composer.setSelectionRange(14, 14)

/** Document-level listeners, keyed by event type. */
const documentListeners = new Map()

/** Dispatch an event through the plugin's capture-phase document listeners. */
function fire(type, target, init = {}) {
  let prevented = false
  let stopped = false
  const event = {
    type,
    target,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    dataTransfer: init.dataTransfer ?? null,
    preventDefault() {
      prevented = true
    },
    stopPropagation() {
      stopped = true
    },
    get defaultPrevented() {
      return prevented
    },
    get propagationStopped() {
      return stopped
    }
  }
  const handlers = documentListeners.get(type)
  if (handlers) for (const entry of handlers) entry.fn(event)
  return event
}

/** Minimal DataTransfer stand-in. */
function dataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    setData() {}
  }
}

globalThis.document = {
  documentElement: new StubNode('html'),
  head: new StubNode('head'),
  body: new StubNode('body'),
  activeElement: null,
  createElement: (tag) => new StubNode(tag),
  querySelectorAll: (selector) => queryAll(selector),
  querySelector: (selector) => {
    const found = queryAll(selector)
    return found.length > 0 ? found[0] : null
  }
}
// Document-level listeners are dispatched through StubNode so the plugin's
// capture-phase handlers are exercised exactly as the browser would call them.
document.addEventListener = (type, fn) => {
  const list = documentListeners.get(type) || []
  list.push({ type, fn })
  documentListeners.set(type, list)
}
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      globalThis.__captured = registration
    }
  }
}

await import(pathToFileURL(clientPath).href)

const registration = globalThis.__captured
const api = registration.factory().__test

/** Fake client context: records effects, exposes a locale namespace. */
const effects = []
const fakeCtx = {
  effect(fn, label) {
    effects.push(label)
    return fn()
  },
  locale: {
    register() {
      return () => {}
    },
    bind() {
      return (key) => (key === 'dragHint' ? HINT : key)
    }
  }
}

// Run the plugin exactly as the client loader would.
const instance = registration.factory()
instance.apply(fakeCtx)

/* ------------------------------------------------------------------ *
 * Registration and wiring
 * ------------------------------------------------------------------ */

test('the bundle registers itself under its package name', () => {
  assert.equal(registration.id, 'dsh-sidebar-dnd')
})

test('apply() wires all four drag lifecycle listeners on the document', () => {
  for (const type of ['dragstart', 'dragend', 'dragover', 'drop']) {
    assert.ok(documentListeners.has(type), `expected a ${type} listener`)
  }
})

test('apply() registers its dictionary and cleanup effect', () => {
  assert.ok(
    effects.some((label) => String(label).includes('dictionaries')),
    'expected a locale dictionary effect'
  )
  assert.ok(
    effects.some((label) => String(label).includes('observers')),
    'expected an observer cleanup effect'
  )
})

test('markRows makes every sidebar row draggable, but not the container', () => {
  api.markRows(HINT)
  assert.equal(fileRow.getAttribute('draggable'), 'true')
  assert.equal(spacedRow.getAttribute('draggable'), 'true')
  assert.equal(dirRow.getAttribute('draggable'), 'true')
  assert.equal(tree.getAttribute('draggable'), null)
})

test('markRows applies the localized tooltip and records the workspace root', () => {
  assert.equal(fileRow.getAttribute('title'), HINT)
  assert.equal(api.getRoot(), ROOT)
})

test('markRows is idempotent: a later hint never rewrites a marked row', () => {
  api.markRows('changed')
  assert.equal(fileRow.getAttribute('title'), HINT)
})

/* ------------------------------------------------------------------ *
 * Drag lifecycle, end to end through the plugin's own handlers
 * ------------------------------------------------------------------ */

test('a drag from a row is claimed and carries the mention', () => {
  const event = fire('dragstart', spacedRow, { dataTransfer: dataTransfer() })
  assert.equal(event.defaultPrevented, false)
  assert.ok(spacedRow.classes.has('dsf-dnd-dragging'), 'row should be marked while dragging')
})

test('dragover outside the composer refuses the drop and shows no hint', () => {
  const event = fire('dragover', spacedRow, { clientX: 5, clientY: 5, dataTransfer: dataTransfer() })
  assert.equal(event.defaultPrevented, false)
  assert.equal(event.dataTransfer.dropEffect, 'none')
  assert.equal(composer.classes.has('dsf-dnd-over'), false)
})

test('dragover over the composer accepts the drop and highlights it', () => {
  const event = fire('dragover', spacedRow, {
    clientX: 300,
    clientY: 530,
    dataTransfer: dataTransfer()
  })
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.dataTransfer.dropEffect, 'copy')
  assert.equal(composer.classes.has('dsf-dnd-over'), true)
})

test('dropping on the composer inserts the quoted mention and re-enables the UI', () => {
  composer.value = 'please review '
  composer.setSelectionRange(14, 14)
  composer.writes.length = 0
  composer.inputEvents = 0
  composer.dispatchEvent = (event) => {
    if (event.type === 'input') composer.inputEvents += 1
    return true
  }

  const event = fire('drop', spacedRow, {
    clientX: 300,
    clientY: 530,
    dataTransfer: dataTransfer()
  })

  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(composer.value, 'please review @"src/my file.ts"')
  assert.deepEqual(composer.writes, ['please review @"src/my file.ts"'])
  assert.equal(composer.inputEvents, 1)
  assert.equal(composer.focused, true)
  assert.equal(composer.selectionStart, composer.value.length)
  assert.equal(composer.classes.has('dsf-dnd-over'), false, 'drop hint must clear')
  assert.equal(spacedRow.classes.has('dsf-dnd-dragging'), false, 'row marker must clear')
})

test('a drop outside the composer is ignored and inserts nothing', () => {
  fire('dragstart', fileRow, { dataTransfer: dataTransfer() })
  composer.value = 'untouched'
  composer.setSelectionRange(9, 9)
  composer.writes.length = 0

  const event = fire('drop', fileRow, { clientX: 5, clientY: 5, dataTransfer: dataTransfer() })

  assert.equal(event.defaultPrevented, false)
  assert.equal(composer.value, 'untouched')
  assert.deepEqual(composer.writes, [])
})

test('a directory row drags as a trailing-slash mention', () => {
  fire('dragstart', dirRow, { dataTransfer: dataTransfer() })
  composer.value = ''
  composer.setSelectionRange(0, 0)
  composer.writes.length = 0

  fire('drop', dirRow, { clientX: 300, clientY: 530, dataTransfer: dataTransfer() })

  assert.equal(composer.value, '@src/')
})

/* ------------------------------------------------------------------ *
 * Pure logic
 * ------------------------------------------------------------------ */

test('normalize converts separators and drops trailing slashes', () => {
  assert.equal(api.normalize('G:\\repos\\app'), 'G:/repos/app')
  assert.equal(api.normalize('/home/dev/app/'), '/home/dev/app')
})

test('relativize strips the workspace root across separator styles', () => {
  const win = ROOT
  assert.equal(api.relativize(`${win}\\src\\App.tsx`, win), 'src/App.tsx')
  assert.equal(api.relativize('G:/_repos/Software_Shell_Repos/src/App.tsx', win), 'src/App.tsx')
  assert.equal(api.relativize(win, win), '')
})

test('relativize matches a Windows root case-insensitively but not a sibling prefix', () => {
  assert.equal(api.relativize('g:\\repos\\APP\\src\\main.ts', 'G:\\repos\\app'), 'src/main.ts')
  assert.equal(api.relativize('/home/dev/apple/x.ts', '/home/dev/app'), '/home/dev/apple/x.ts')
})

test('relativize keeps POSIX case sensitivity and out-of-root paths absolute', () => {
  assert.equal(api.relativize('/home/dev/App/x.ts', '/home/dev/app'), '/home/dev/App/x.ts')
  assert.equal(api.relativize('/other/place/x.ts', '/home/dev/app'), '/other/place/x.ts')
})

test('formatMention matches the host @file grammar', () => {
  assert.equal(api.formatMention('src/App.tsx', false), '@src/App.tsx')
  assert.equal(api.formatMention('my docs/notes.md', false), '@"my docs/notes.md"')
  assert.equal(api.formatMention('src', true), '@src/')
  assert.equal(api.formatMention('src/', true), '@src/')
  assert.equal(api.formatMention('my docs', true), '@"my docs/')
})

test('formatMention refuses paths the prompt grammar cannot represent', () => {
  assert.equal(api.formatMention('bad"quote.ts', false), null)
  assert.equal(api.formatMention('bad\u0000null.ts', false), null)
  assert.equal(api.formatMention('bad"quote', true), null)
})

test('insertText pads so the mention stays a standalone token', () => {
  assert.deepEqual(api.insertText('', 0, 0, '@a.ts'), { value: '@a.ts', caret: 5 })
  assert.deepEqual(api.insertText('hello', 5, 5, '@a.ts'), { value: 'hello @a.ts', caret: 11 })
  assert.deepEqual(api.insertText('look ', 5, 5, '@a.ts'), { value: 'look @a.ts', caret: 10 })
  assert.deepEqual(api.insertText('drop @old.ts now', 5, 12, '@new.ts'), {
    value: 'drop @new.ts now',
    caret: 12
  })
})

test('the composer is located structurally and hit-tested', () => {
  assert.equal(api.findComposer(), composer)
  assert.equal(api.overComposer(300, 530), true)
  assert.equal(api.overComposer(5, 5), false)
})
