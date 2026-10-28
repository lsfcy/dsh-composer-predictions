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
