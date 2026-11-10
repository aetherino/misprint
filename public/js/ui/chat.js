// In-match chat: recent lines fade on their own; the input only exists while the player is typing.
import { h } from './dom.js';
import { inkHex } from './faces.js';

const LINE_TTL = 7000;
const MAX_LINES = 6;

export function createChat(app) {
  const lines = h('ol.chat-lines', { 'aria-live': 'polite', 'aria-label': 'Chat' });
  const input = h('input.chat-input', { type: 'text', maxLength: 140, autocomplete: 'off', spellcheck: false, 'aria-label': 'Chat message', placeholder: 'Enter to send, Esc to cancel' });
  const form = h('form.chat-form', { hidden: true }, h('span.tag', null, 'Say'), input);
  const el = h('div.chat', { hidden: true }, lines, form);

  function close() {
    if (form.hidden) return;
    form.hidden = true;
    input.value = '';
    input.blur();
    el.classList.remove('is-open');
    app.onTypingChanged();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) app.actions.chat(text);
    close();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();   // game keys must not fire while typing
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('blur', close);

  return {
    el,
    push(m) {
      const li = m.system
        ? h('li.chat-sys', null, m.text)
        : h('li', null, h('i.chat-ink', { style: `background:${inkHex(m.color)}` }), h('b', null, m.fromName), ' ', m.text);
      lines.appendChild(li);
      while (lines.children.length > MAX_LINES) lines.firstChild.remove();
      setTimeout(() => li.classList.add('is-old'), LINE_TTL);
    },
    open() {
      form.hidden = false;
      el.classList.add('is-open');
      input.focus({ preventScroll: true });
      app.onTypingChanged();
    },
    close,
    get isOpen() { return !form.hidden; },
  };
}
