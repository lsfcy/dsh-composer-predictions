// GENERATED FILE — edit src/ghost.js or src/main.js and run: node build.mjs
window.__ModuleLoader__.load({
  id: "@lsfcy/dsh-composer-predictions",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
/**
 * Ghost-text layer for the DSH composer.
 *
 * Paints one dimmed line of "predicted next message" inside an EMPTY composer,
 * the way Codex shows composer predictions. Pure DOM: no React, no imports, so
 * the DSH client bundle and the demo pages run the exact same code (build.mjs
 * concatenates this file into client.js).
 *
 * The composer is a Lexical contenteditable (`[data-composer-input]`), not a
 * textarea, and it already ships its own absolutely-positioned placeholder
 * (`[data-composer-placeholder]`) inside the same `position:relative` `.grow`
 * wrapper. The layer therefore measures THAT element on every paint and copies
 * its typography, so it sits exactly where the placeholder sits without any
 * hard-coded inset. A plain textarea (the demo harness) falls back to the
 * target's own border box.
 *
 * The placeholder is hidden with `visibility` rather than `display`: its box
 * (and therefore the geometry we measure) survives, and React re-creating the
 * placeholder after a draft round-trip cannot leave two lines painted at once —
 * each paint re-queries the live node and hides the current one.
 *
 * Contract:
 *   const layer = createGhostLayer(target, { onAccept, onDismiss, canIntercept })
 *   layer.setText('run the tests')   // '' hides
 *   layer.getText()                  // current line ('' when hidden)
 *   layer.destroy()
 *
 * Keys while the ghost is showing, captured on the CONTAINER (an ancestor), so
 * the listener runs before Lexical's own root listener on the target:
 *   Tab      -> accept: hide, then onAccept(text)
 *   Escape   -> dismiss: hide, then onDismiss()
 *   typing   -> dismiss; the composer inserts the character as usual
 */
;(function (global) {
  'use strict'

  var COPIED_PROPERTIES = [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-variant',
    'font-stretch',
    'letter-spacing',
    'line-height',
    'text-transform',
    'text-indent',
    'tab-size',
    'direction',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'box-sizing',
    'overflow-wrap',
    'word-break',
    'text-align',
  ]

  /** True when the composer holds no text of the user's own. */
  function isEmpty(target) {
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return target.value === ''
    return String(target.textContent || '').replace(/\u200b/g, '').trim() === ''
  }

  function copyStyle(from, parts) {
    var style = global.getComputedStyle(from)
    for (var index = 0; index < COPIED_PROPERTIES.length; index += 1) {
      var name = COPIED_PROPERTIES[index]
      var value = style.getPropertyValue(name)
      if (value) parts.push(name + ':' + value)
    }
    if (style.color) parts.push('color:' + style.color)
  }

  function createGhostLayer(target, options) {
    var opts = options || {}
    if (!target || !target.parentElement) return null

    var container = target.parentElement
    var previousPosition = container.style.position
    if (global.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }

    var element = document.createElement('div')
    element.dataset.composerPrediction = 'ghost'
    element.setAttribute('aria-hidden', 'true')
    // Keep the pre-first-paint state out of flow so the composer never grows a
    // stray line before a prediction exists.
    element.style.display = 'none'
    container.appendChild(element)

    var shown = ''
    var placeholder = null

    function livePlaceholder() {
      return container.querySelector('[data-composer-placeholder]')
    }

    /** Hide the CURRENT placeholder. A React remount is handled on every paint. */
    function hidePlaceholder() {
      var next = livePlaceholder()
      if (placeholder !== next) {
        restorePlaceholder()
        placeholder = next
      }
      // DSH never sets an inline visibility on this node, so '' is the honest
      // neutral value. Keeping the box (rather than display:none) is what lets
      // the next paint measure the same rectangle.
      if (next) next.style.visibility = 'hidden'
    }

    function restorePlaceholder() {
      if (placeholder && placeholder.style) placeholder.style.visibility = ''
      placeholder = null
    }

    function measure(source) {
      if (source !== target) {
        return {
          left: source.offsetLeft,
          top: source.offsetTop,
          width: source.offsetWidth,
          height: source.offsetHeight,
        }
      }
      var box = target.getBoundingClientRect()
      var frame = container.getBoundingClientRect()
      return {
        left: box.left - frame.left - container.clientLeft + container.scrollLeft,
        top: box.top - frame.top - container.clientTop + container.scrollTop,
        width: box.width,
        height: box.height,
      }
    }

    function paint() {
      var parts = [
        'display:block',
        'position:absolute',
        'pointer-events:none',
        'user-select:none',
        'z-index:4',
        'margin:0',
        'overflow:hidden',
        'text-overflow:ellipsis',
        'white-space:nowrap',
        'opacity:.5',
      ]
      var source = livePlaceholder() || target
      copyStyle(source, parts)
      // Single-line ellipsis wins over the placeholder's own wrapping rules.
      parts.push('white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis')
      if (source === target) {
        parts.push('border-style:solid', 'border-color:transparent', 'background:transparent')
      }
      var box = measure(source)
      if (box.width > 0) {
        parts.push('left:' + box.left + 'px', 'top:' + box.top + 'px', 'width:' + box.width + 'px')
        if (box.height > 0) parts.push('height:' + box.height + 'px')
      }
      element.style.cssText = parts.join(';')
    }

    function render() {
      // A non-empty draft always wins: the user is already typing their own message.
      var blocked =
        isEmpty(target) === false ||
        target.getAttribute('aria-disabled') === 'true' ||
        target.getBoundingClientRect().width === 0
      if (!shown || blocked) {
        element.style.display = 'none'
        element.textContent = ''
        restorePlaceholder()
        return
      }
      element.textContent = shown
      paint()
      element.style.display = 'block'
      // Hide only after measuring: the hidden node keeps its box, so the next
      // paint still measures the same rectangle.
      hidePlaceholder()
    }

    function hide() {
      shown = ''
      render()
    }

    function canIntercept() {
      return typeof opts.canIntercept === 'function' ? opts.canIntercept() !== false : true
    }

    function acceptShown() {
      var text = shown
      hide()
      if (opts.onAccept) opts.onAccept(text)
    }

    function onKeyDown(event) {
      if (!shown || element.style.display === 'none') return
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        // The slash/@ completion menu owns Tab while it is open.
        if (!canIntercept()) return
        event.preventDefault()
        event.stopPropagation()
        acceptShown()
        return
      }
      if (event.key === 'Escape') {
        // A dialog or menu owns Escape; never close it on the user's behalf.
        if (!canIntercept()) return
        event.preventDefault()
        event.stopPropagation()
        hide()
        if (opts.onDismiss) opts.onDismiss()
        return
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        hide()
        if (opts.onDismiss) opts.onDismiss()
      }
    }

    /**
     * Tab with nothing focused. Switching sessions in DSH leaves focus on
     * <body>; the container listener never sees that key, so the visible
     * suggestion would otherwise be unreachable without clicking the composer
     * first. Only the no-focus state is claimed: a focused control keeps its
     * normal Tab navigation.
     */
    function onDocumentKeyDown(event) {
      if (!shown || element.style.display === 'none') return
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      var active = global.document ? global.document.activeElement : null
      if (active !== null && active !== global.document.body && active !== global.document.documentElement) return
      if (!canIntercept()) return
      event.preventDefault()
      event.stopPropagation()
      acceptShown()
    }

    function onInput() {
      render()
    }

    function onCompositionStart() {
      if (!shown) return
      hide()
      if (opts.onDismiss) opts.onDismiss()
    }

    var observer = typeof global.ResizeObserver === 'function' ? new global.ResizeObserver(render) : null
    if (observer) observer.observe(target)
    // The placeholder is a React child: a draft round-trip replaces the node.
    // Re-hide the live one instead of trusting the node captured at attach time.
    var mutations =
      typeof global.MutationObserver === 'function'
        ? new global.MutationObserver(function () {
            if (shown) render()
          })
        : null
    if (mutations) mutations.observe(container, { childList: true })
    global.addEventListener('resize', render)
    // Capture on the ancestor: for listeners registered on the SAME node as
    // Lexical's, capture and bubble listeners both run in registration order,
    // so the ancestor is the only place that reliably runs first.
    container.addEventListener('keydown', onKeyDown, true)
    container.addEventListener('input', onInput, true)
    container.addEventListener('compositionstart', onCompositionStart, true)
    target.addEventListener('focus', render)
    if (global.document) global.document.addEventListener('keydown', onDocumentKeyDown, true)

    return {
      element: element,
      setText: function (text) {
        shown = String(text == null ? '' : text).replace(/\s*\n+\s*/g, ' ').trim()
        render()
      },
      getText: function () {
        return shown
      },
      isShowing: function () {
        return shown !== '' && element.style.display !== 'none'
      },
      hide: hide,
      destroy: function () {
        restorePlaceholder()
        if (observer) observer.disconnect()
        if (mutations) mutations.disconnect()
        global.removeEventListener('resize', render)
        container.removeEventListener('keydown', onKeyDown, true)
        container.removeEventListener('input', onInput, true)
        container.removeEventListener('compositionstart', onCompositionStart, true)
        target.removeEventListener('focus', render)
        if (global.document) global.document.removeEventListener('keydown', onDocumentKeyDown, true)
        element.remove()
        container.style.position = previousPosition
      },
    }
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports.createGhostLayer = createGhostLayer
  }
  // Also reachable as a global so the standalone demo pages can load this file
  // with a plain <script> and exercise the very same implementation.
  global.createComposerGhost = createGhostLayer
  global.composerGhostIsEmpty = isEmpty
})(typeof globalThis === 'undefined' ? this : globalThis)

// Browser half body. build.mjs concatenates src/ghost.js (which defines
// globalThis.createComposerGhost) in front of this file and wraps the pair in
// the lazy-CJS bundle envelope, so `require` here is the module loader's.
//
// What this registers: one entry in the additive "conversation.input.dock"
// slot (kind: list, scope: session). The dock renders inside the composer stack
// and hands every entry { session, input } plus the standard session kit —
// including `sessionId` and `inputActions`. That is everything a prediction
// needs:
//
//   running: true   -> a turn is in flight; drop any suggestion
//   running: false  -> a turn just settled; ask the host for a prediction
//   draft !== ''    -> the user is writing; dismiss it and never refetch
//
// The visible suggestion is NOT React: src/ghost.js paints it into the Lexical
// composer (`[data-composer-input]`), because the only in-box seat DSH exposes
// is a full composer takeover. This entry renders a hidden anchor, which lets
// the layer find the composer seat that owns THIS session (so a second mounted
// conversation can never paint into the wrong editor) without adding a row,
// margin, or hint line that would shift the composer.

const react = require('react')
const h = react.createElement
const createGhostLayer = globalThis.createComposerGhost

const PREDICT_PATH = '/composer-predictions/predict'
const CONFIG_PATH = '/composer-predictions/config'
const OPTIONS_PATH = '/composer-predictions/options'
const CLIENT_TIMEOUT_MS = 30_000
const ATTACH_FRAMES = 120

const selectRunning = (state) => !!(state && state.running)
const noSession = () => undefined

/**
 * One config snapshot shared by the dock (whether to ask at all) and the
 * Settings page (what to show). The host owns persistence; this store only
 * caches the last read so a re-render never refetches.
 */
const configStore = (() => {
  let snapshot = null
  let pending = null
  let options = null
  let optionsPending = null
  const listeners = new Set()
  const publish = (next) => {
    snapshot = next
    for (const listener of listeners) listener(next)
  }
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load() {
      if (pending) return pending
      pending = fetch(CONFIG_PATH, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
        .then((payload) => {
          if (payload && payload.config) publish(payload.config)
          return snapshot
        })
        .catch((error) => {
          console.warn(
            '[composer-predictions] config load failed:',
            error && error.message ? error.message : error,
          )
          // A stale host (client updated first) must not silently disable
          // predictions: fall back to the default-on behaviour and let the
          // settings page explain that persistence is unavailable.
          publish({ enabled: true, unavailable: true })
          return snapshot
        })
        .finally(() => {
          pending = null
        })
      return pending
    },
    getOptions: () => options,
    loadOptions(force = false) {
      if (optionsPending) return optionsPending
      if (!force && options) return Promise.resolve(options)
      optionsPending = fetch(OPTIONS_PATH, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
        .then((payload) => {
          options = {
            providers: Array.isArray(payload && payload.providers) ? payload.providers : [],
            models: Array.isArray(payload && payload.models) ? payload.models : [],
            autoProvider: payload && typeof payload.autoProvider === 'string' ? payload.autoProvider : '',
          }
          return options
        })
        .catch((error) => {
          console.warn(
            '[composer-predictions] options load failed:',
            error && error.message ? error.message : error,
          )
          options = { providers: [], models: [], autoProvider: '' }
          return options
        })
        .finally(() => {
          optionsPending = null
        })
      return optionsPending
    },
    async save(patch) {
      const response = await fetch(CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: patch }),
        cache: 'no-store',
        credentials: 'same-origin',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      if (payload && payload.config) publish(payload.config)
      return payload && payload.config
    },
  }
})()

function useConfig() {
  const [snapshot, setSnapshot] = react.useState(configStore.get)
  react.useEffect(() => configStore.subscribe(setSnapshot), [])
  react.useEffect(() => {
    if (configStore.get() === null) configStore.load()
  }, [])
  return snapshot
}

const COPY = {
  zh: {
    section: '输入框预测',
    title: '输入框预测',
    intro: '一轮回答结束后，在空的输入框里用灰字给出你接下来可能发送的消息。Tab 接受，Esc 忽略。',
    enabled: '启用预测',
    enabledHint: '关闭后不再请求模型，也不显示灰字；已显示的建议会立即隐藏。',
    provider: '模型 provider',
    providerHint: '留空 = 自动使用当前选中的 provider。',
    model: '模型 id',
    modelHint: '留空 = 自动选该 provider 下最便宜的型号。',
    effort: '推理档',
    effortHint: '留空 = 自动选支持的最省一档；模型不支持的档位会自动退到最省档。',
    auto: '自动',
    save: '保存',
    reset: '恢复默认',
    saving: '保存中…',
    saved: '已保存',
    failed: '保存失败：',
    loading: '正在读取配置…',
    readOnly: '当前运行时不支持持久化配置。',
  },
  en: {
    section: 'Composer prediction',
    title: 'Composer prediction',
    intro: 'After a turn settles, the empty composer shows a dim next-message suggestion. Tab accepts it; Escape dismisses it.',
    enabled: 'Enable predictions',
    enabledHint: 'Off stops every request and hides the ghost immediately.',
    provider: 'Model provider',
    providerHint: 'Empty = the provider you are currently using.',
    model: 'Model id',
    modelHint: 'Empty = the cheapest model on that provider.',
    effort: 'Reasoning effort',
    effortHint: 'Empty = the cheapest effort the model supports; an unsupported pinned effort falls back to the cheapest one.',
    auto: 'Auto',
    save: 'Save',
    reset: 'Reset to defaults',
    saving: 'Saving…',
    saved: 'Saved',
    failed: 'Save failed: ',
    loading: 'Loading configuration…',
    readOnly: 'This runtime cannot persist configuration.',
  },
}

// The app's locale service mirrors the active language onto <html lang>; the
// Electron renderer's navigator.language stays en-US, so reading it would keep
// an English page under a Chinese app. Track the attribute and re-render on it.
function currentLocale() {
  if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
    return document.documentElement.lang
  }
  return (typeof navigator !== 'undefined' && navigator.language) || 'en'
}

function copy(locale) {
  const language = String(locale || currentLocale()).toLowerCase()
  return language.indexOf('zh') === 0 ? COPY.zh : COPY.en
}

function useLocaleId() {
  const [locale, setLocale] = react.useState(currentLocale)
  react.useEffect(() => {
    if (typeof document === 'undefined' || !document.documentElement) return undefined
    const element = document.documentElement
    const sync = () => setLocale(currentLocale())
    const observer = new MutationObserver(sync)
    observer.observe(element, { attributes: true, attributeFilter: ['lang'] })
    sync()
    return () => observer.disconnect()
  }, [])
  return locale
}

const FIELD_STYLE = {
  width: '100%',
  boxSizing: 'border-box',
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
  background: 'var(--dsw-alias-bg-module-platform, #fff)',
  color: 'var(--dsw-alias-label-primary, #1d2129)',
  font: 'inherit',
  fontSize: 13,
  outline: 'none',
}

const CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: '18px 20px',
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
}

const LABEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary, #1d2129)',
}

const HINT_STYLE = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #86909c)' }

function Switch({ checked, label, onToggle }) {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      onClick: () => onToggle(!checked),
      style: {
        position: 'relative',
        flex: 'none',
        width: 40,
        height: 22,
        padding: 0,
        border: 'none',
        borderRadius: 999,
        cursor: 'pointer',
        background: checked
          ? 'var(--dsw-alias-state-business-primary, #2f6fed)'
          : 'var(--dsw-alias-border-l2, #c9cdd4)',
        transition: 'background .15s ease',
      },
    },
    h('span', {
      style: {
        position: 'absolute',
        top: 2,
        left: checked ? 20 : 2,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left .15s ease',
        boxShadow: '0 1px 2px rgba(0,0,0,.2)',
      },
    }),
  )
}

function Field({ label, hint, children }) {
  return h('label', { style: LABEL_STYLE }, h('span', null, label), children, hint ? h('span', { style: HINT_STYLE }, hint) : null)
}

/**
 * A text input backed by a datalist: clicking shows the known providers or
 * models, typing still accepts a value the catalog does not advertise.
 */
const POPUP_STYLE = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  zIndex: 40,
  padding: 4,
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
  background: 'var(--dsw-alias-bg-module-platform, #fff)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, .12)',
  maxHeight: 240,
  overflowY: 'auto',
}

function Chevron({ open }) {
  return h(
    'svg',
    {
      width: 12,
      height: 12,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' },
    },
    h('path', { d: 'M4 6l4 4 4-4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

/**
 * One themed combobox: the input stays editable (when `allowCustom`), the
 * popup is a token-styled list rather than the OS select/datalist chrome.
 */
function Combo({ label, hint, value, placeholder, options, allowCustom = true, onChange }) {
  const [open, setOpen] = react.useState(false)
  const [active, setActive] = react.useState(-1)
  const rootRef = react.useRef(null)

  react.useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const choose = (next) => {
    onChange(next)
    setOpen(false)
  }

  return h(
    Field,
    { label, hint },
    h(
      'div',
      { ref: rootRef, style: { position: 'relative' } },
      h('input', {
        type: 'text',
        value,
        placeholder,
        readOnly: !allowCustom,
        autoComplete: 'off',
        onChange: (event) => {
          if (!allowCustom) return
          onChange(event.target.value)
          setOpen(true)
        },
        onClick: () => setOpen((current) => !current),
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActive((index) => Math.min(options.length - 1, index + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index) => Math.max(0, index - 1))
          } else if (event.key === 'Enter' && open && active >= 0 && options[active]) {
            event.preventDefault()
            choose(options[active].value)
          }
        },
        style: {
          ...FIELD_STYLE,
          paddingRight: 34,
          cursor: allowCustom ? 'text' : 'pointer',
        },
      }),
      h(
        'span',
        {
          style: {
            position: 'absolute',
            right: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            pointerEvents: 'none',
            color: 'var(--dsw-alias-label-tertiary, #86909c)',
          },
        },
        h(Chevron, { open }),
      ),
      open && options.length > 0
        ? h(
            'div',
            { style: POPUP_STYLE },
            options.map((option, index) =>
              h(
                'button',
                {
                  key: option.value === '' ? '__auto' : option.value,
                  type: 'button',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => choose(option.value),
                  onMouseEnter: () => setActive(index),
                  style: {
                    display: 'flex',
                    width: '100%',
                    border: 'none',
                    padding: '7px 10px',
                    borderRadius: 6,
                    font: 'inherit',
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                    background:
                      option.value === value
                        ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6fed) 10%, transparent)'
                        : 'transparent',
                    color:
                      option.value === value
                        ? 'var(--dsw-alias-state-business-primary, #2f6fed)'
                        : 'var(--dsw-alias-label-primary, #1d2129)',
                    outline: index === active ? '1px solid var(--dsw-alias-border-l2, #e5e6eb)' : 'none',
                  },
                },
                option.label,
              ),
            ),
          )
        : null,
    ),
  )
}

function PredictionSettings() {
  const config = useConfig()
  const locale = useLocaleId()
  const words = copy(locale)
  const [draft, setDraft] = react.useState(null)
  const [status, setStatus] = react.useState('')
  const [busy, setBusy] = react.useState(false)
  const [options, setOptions] = react.useState(() => configStore.getOptions())

  react.useEffect(() => {
    let alive = true
    const refresh = () => {
      configStore.loadOptions(true).then((value) => {
        if (alive) setOptions(value)
      })
    }
    // A provider added in another settings section must be visible here on the
    // next visit, and on returning to the window, not after a restart.
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [])

  react.useEffect(() => {
    if (!config || config.unavailable) return
    setDraft((current) =>
      current ?? {
        enabled: config.enabled !== false,
        provider: config.provider || '',
        model: config.model || '',
        reasoningEffort: config.reasoningEffort || '',
      },
    )
  }, [config])

  const save = async (next) => {
    setBusy(true)
    setStatus('')
    try {
      await configStore.save(next)
      setStatus(words.saved)
    } catch (error) {
      setStatus(words.failed + (error && error.message ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  if (config && config.unavailable) {
    return h('section', { style: { padding: '8px 0', color: 'var(--dsw-alias-label-tertiary, #86909c)', fontSize: 13 } }, words.readOnly)
  }
  if (!config || !draft) {
    return h('section', { style: { padding: '8px 0', color: 'var(--dsw-alias-label-tertiary, #86909c)', fontSize: 13 } }, words.loading)
  }

  const update = (patch) => setDraft({ ...draft, ...patch })

  const providerChoices = (options ? options.providers : []).map((provider) => ({
    value: provider.id,
    label: provider.name && provider.name !== provider.id ? provider.name + ' · ' + provider.id : provider.id,
  }))
  const effectiveProvider = draft.provider || (options ? options.autoProvider : '')
  const seenModels = new Set()
  const modelChoices = []
  for (const model of options ? options.models : []) {
    if (model.provider !== effectiveProvider || seenModels.has(model.id)) continue
    seenModels.add(model.id)
    modelChoices.push({ value: model.id, label: model.name && model.name !== model.id ? model.name + ' · ' + model.id : model.id })
  }

  return h(
    'section',
    { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 640, padding: '8px 0 24px' } },
    h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, words.title),
    h('p', { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #4e5969)' } }, words.intro),
    h(
      'div',
      { style: CARD_STYLE },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: { fontSize: 13 } }, words.enabled),
          h('span', { style: HINT_STYLE }, words.enabledHint),
        ),
        h(Switch, {
          checked: draft.enabled !== false,
          label: words.enabled,
          onToggle: (enabled) => update({ enabled }),
        }),
      ),
      h(Combo, {
        label: words.provider,
        hint: words.providerHint,
        value: draft.provider,
        placeholder: words.auto,
        options: [{ value: '', label: words.auto }].concat(providerChoices),
        onChange: (provider) => update({ provider }),
      }),
      h(Combo, {
        label: words.model,
        hint: words.modelHint,
        value: draft.model,
        placeholder: words.auto,
        options: [{ value: '', label: words.auto }].concat(modelChoices),
        onChange: (model) => update({ model }),
      }),
      h(Combo, {
        label: words.effort,
        hint: words.effortHint,
        value: draft.reasoningEffort,
        placeholder: words.auto,
        allowCustom: false,
        options: [''].concat(['off', 'none', 'minimal', 'low', 'high']).map((value) => ({
          value,
          label: value === '' ? words.auto : value,
        })),
        onChange: (reasoningEffort) => update({ reasoningEffort }),
      }),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      h(
        'button',
        {
          type: 'button',
          disabled: busy,
          onClick: () => save(draft),
          style: {
            height: 32,
            padding: '0 16px',
            borderRadius: 8,
            border: 'none',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            background: 'var(--dsw-alias-state-business-primary, #2f6fed)',
            color: '#fff',
            font: 'inherit',
            fontSize: 13,
          },
        },
        busy ? words.saving : words.save,
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: busy,
          onClick: () => {
            const next = { enabled: true, provider: '', model: '', reasoningEffort: '' }
            setDraft(next)
            save(next)
          },
          style: {
            height: 32,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary, #4e5969)',
            cursor: busy ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 13,
          },
        },
        words.reset,
      ),
      status ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #86909c)' } }, status) : null,
    ),
  )
}

/**
 * The composer editable surface that belongs to this dock's conversation seat.
 * `[data-composer-input]` is a Lexical contenteditable, not a textarea.
 */
function findComposerInput(anchor) {
  const seat = anchor && typeof anchor.closest === 'function'
    ? anchor.closest('[data-conversation-region="composer"]')
    : null
  const scope = seat || document
  const nodes = scope.querySelectorAll('[data-composer-input]')
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const element = nodes[index]
    const box = element.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) return element
  }
  return null
}

/**
 * A completion menu owns Tab/Escape while it is open; never steal either.
 *
 * The overlay anchor always exists and always contains the slot wrapper (and a
 * hidden placeholder span in the closed state), so `childElementCount > 0` is
 * permanently true — the bug that made Tab do nothing in the first real build.
 * Only a laid-out overlay node counts: slot wrappers (`display: contents`) and
 * hidden nodes are skipped, and the remaining node must have a real box.
 */
function completionMenuOpen(anchor) {
  const seat = anchor && typeof anchor.closest === 'function'
    ? anchor.closest('[data-conversation-region="composer"]')
    : null
  const overlay = (seat || document).querySelector('[data-composer-overlay]')
  if (!overlay) return false
  const nodes = overlay.querySelectorAll('*')
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node.hasAttribute('data-slot') || node.hasAttribute('hidden')) continue
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const box = node.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) return true
  }
  return false
}

function PredictionDock(props) {
  const session = props.session || {}
  const input = props.input || {}
  const draft = typeof input.draft === 'string' ? input.draft : ''
  // The standard session kit always supplies useSession; the fallback keeps the
  // component usable in the bundle test and during a partial boot.
  const useSession = typeof props.useSession === 'function' ? props.useSession : noSession
  const liveRunning = useSession(selectRunning)
  const running = typeof liveRunning === 'boolean' ? liveRunning : !!(session && session.running)
  const pending = Array.isArray(session.pendingSubmissions)
    ? session.pendingSubmissions
    : Array.isArray(session.pending)
      ? session.pending
      : []
  // Only queued submissions hold a turn open; transcript-placement entries are
  // already part of the conversation.
  const queued = pending.some((item) => item && item.placement === 'queued')
  const sessionId = props.sessionId || session.sessionId || ''
  const config = useConfig()
  const configReady = config !== null
  const disabled = config !== null && config.enabled === false

  const [prediction, setPrediction] = react.useState('')
  const predictionRef = react.useRef('')
  predictionRef.current = prediction
  const draftRef = react.useRef(draft)
  draftRef.current = draft
  const actionsRef = react.useRef(props.inputActions)
  actionsRef.current = props.inputActions
  // A request is wanted after mount, after a session switch, and after each
  // finished turn. The host re-uses its per-session cache, so re-entering an
  // idle session costs one loopback round-trip, not a model call.
  const needs = react.useRef(true)
  const requestSeq = react.useRef(0)
  const retryCount = react.useRef(0)
  const retryTimer = react.useRef(null)
  const [retryTick, setRetryTick] = react.useState(0)
  const anchorRef = react.useRef(null)
  const ghostRef = react.useRef(null)
  const editorRef = react.useRef(null)
  const lastSession = react.useRef(sessionId)

  /** Accepting writes a real draft: the text lands in the box and is editable. */
  function accept(value) {
    const text = String(value || predictionRef.current || '').trim()
    if (!text) return
    requestSeq.current += 1
    predictionRef.current = ''
    setPrediction('')
    if (ghostRef.current) ghostRef.current.hide()
    const actions = actionsRef.current
    if (!actions || typeof actions.setDraft !== 'function') return
    actions.setDraft(text)
    const editor = editorRef.current
    if (editor && editor.isConnected && typeof editor.focus === 'function') editor.focus()
  }

  function dismiss() {
    requestSeq.current += 1
    predictionRef.current = ''
    setPrediction('')
    if (ghostRef.current) ghostRef.current.hide()
  }

  function ensureGhost() {
    const anchor = anchorRef.current
    const editor = findComposerInput(anchor)
    if (!editor) {
      if (ghostRef.current) ghostRef.current.destroy()
      ghostRef.current = null
      editorRef.current = null
      return null
    }
    if (ghostRef.current && editorRef.current === editor) return ghostRef.current
    if (ghostRef.current) ghostRef.current.destroy()
    editorRef.current = editor
    ghostRef.current = createGhostLayer(editor, {
      onAccept: (text) => accept(text),
      onDismiss: () => dismiss(),
      canIntercept: () => !completionMenuOpen(anchorRef.current),
    })
    return ghostRef.current
  }

  // One layer per mounted composer. The composer can mount a frame or two after
  // the dock (hero → conversation transition), so retry briefly.
  react.useEffect(() => {
    let disposed = false
    let frames = 0
    const retry = () => {
      if (disposed) return
      const ghost = ensureGhost()
      if (ghost) {
        ghost.setText(draftRef.current === '' ? predictionRef.current : '')
        return
      }
      frames += 1
      if (frames < ATTACH_FRAMES && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(retry)
      }
    }
    retry()
    return () => {
      disposed = true
      if (ghostRef.current) ghostRef.current.destroy()
      ghostRef.current = null
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach once; refs carry state
  }, [])

  // A reused dock instance must never paint the previous session's prediction.
  react.useEffect(() => {
    if (lastSession.current === sessionId) return
    lastSession.current = sessionId
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    retryCount.current = 0
    needs.current = true
    requestSeq.current += 1
    predictionRef.current = ''
    setPrediction('')
  }, [sessionId])

  react.useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      retryTimer.current = null
    },
    [],
  )

  // Writing dismisses for good: clearing the box later must not resurrect a
  // suggestion that belonged to a previous moment in the conversation.
  react.useEffect(() => {
    if (draft === '' || predictionRef.current === '') return
    requestSeq.current += 1
    predictionRef.current = ''
    setPrediction('')
  }, [draft])

  // Paint (or clear) the ghost text.
  react.useEffect(() => {
    const ghost = ensureGhost()
    if (!ghost) return
    ghost.setText(disabled || draft !== '' ? '' : prediction)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  }, [draft, prediction, sessionId, disabled])

  // Ask the host once per settled turn.
  react.useEffect(() => {
    if (!sessionId) return undefined
    // The master switch lives host-side; wait for the snapshot before asking.
    if (!configReady) return undefined
    if (disabled) {
      needs.current = true
      if (predictionRef.current !== '') {
        requestSeq.current += 1
        predictionRef.current = ''
        setPrediction('')
      }
      return undefined
    }

    if (running) {
      // The turn that just started will earn the next suggestion.
      needs.current = true
      if (predictionRef.current !== '') {
        requestSeq.current += 1
        predictionRef.current = ''
        setPrediction('')
      }
      return undefined
    }

    if (!needs.current || draft !== '' || queued) return undefined
    if (predictionRef.current !== '') {
      needs.current = false
      return undefined
    }
    needs.current = false

    const seq = requestSeq.current + 1
    requestSeq.current = seq
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
    const settle = () => clearTimeout(timer)

    fetch(PREDICT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) return response.json()
        let detail = ''
        try {
          const body = await response.json()
          detail = body && typeof body.error === 'string' ? body.error : ''
        } catch {
          detail = ''
        }
        const error = new Error('HTTP ' + response.status + (detail ? ': ' + detail : ''))
        error.status = response.status
        throw error
      })
      .then((payload) => {
        retryCount.current = 0
        if (controller.signal.aborted || requestSeq.current !== seq) return
        if (draftRef.current !== '') return
        const text = payload && typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text || text === 'SKIP') return
        predictionRef.current = text
        setPrediction(text)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        const status = error && typeof error.status === 'number' ? error.status : 0
        console.warn(
          '[composer-predictions] prediction failed' + (sessionId ? ' for ' + sessionId : '') + ':',
          error && error.message ? error.message : error,
        )
        // Opening an old session resumes it on the Host; the first request can
        // race that resume and see 404. Re-arm and retry with backoff instead
        // of leaving this session permanently without a suggestion.
        if (status === 404 || status === 0) {
          needs.current = true
          if (retryCount.current < 6) {
            retryCount.current += 1
            if (retryTimer.current) clearTimeout(retryTimer.current)
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null
              setRetryTick((value) => value + 1)
            }, 350 * retryCount.current)
          }
        }
      })
      .finally(settle)

    return () => {
      settle()
      controller.abort()
    }
  }, [sessionId, running, draft, queued, retryTick, configReady, disabled])

  return h('div', {
    ref: anchorRef,
    'data-composer-predictions': 'anchor',
    'aria-hidden': 'true',
    style: { display: 'none' },
  })
}

function apply(ctx) {
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'composer-predictions',
        // Existing dock entries: todo=0, goal=10, queue=20.
        order: 30,
      },
      PredictionDock,
    ),
  )
  // Settings nav sits after "Plugins" (15) and before "Agent presets" (20).
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'composer-predictions',
        order: 18,
        label: () => copy().section,
      },
      PredictionSettings,
    ),
  )
}

exports.name = 'composer-predictions'
exports.inject = ['slots']
exports.apply = apply

    return module.exports
  },
})
