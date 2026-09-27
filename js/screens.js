const ESTABLISHED_MS = 1000;
const COPIED_MS = 1200;
const PROMPT_HINT = 'ENTER TO CONTINUE · ESC TO GO BACK';

// Tiny DOM builder; strings become text nodes
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (!button) return;
  const label = button.textContent;
  button.textContent = '[COPIED]';
  setTimeout(() => { button.textContent = label; }, COPIED_MS);
}

const termButton = (label, onclick, extra = {}) => h('button', { class: 'term-link', type: 'button', onclick, ...extra }, `[${label}]`);

// Start menu plus the centred call cards
export class Screens {
  constructor({ menu, menuMsg, card }) {
    this.menu = menu;
    this.menuMsg = menuMsg;
    this.card = card;
    this.items = [...menu.querySelectorAll('.menu-item')];
    this.selected = 0;
    this.onMenuSelect = null;
    this.escHandler = null;
    this.items.forEach((el, i) => {
      el.addEventListener('click', () => this.choose(i));
      el.addEventListener('mouseenter', () => this.select(i));
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.select(0);
  }

  get menuOpen() {
    return !this.menu.hidden;
  }

  showMenu(message = '') {
    this.clearCard();
    this.menu.hidden = false;
    this.menuMsg.textContent = message;
    this.menuMsg.hidden = !message;
    this.select(this.selected);
  }

  hideMenu() {
    this.menu.hidden = true;
  }

  select(i) {
    const n = this.items.length;
    this.selected = (i + n) % n;
    this.items.forEach((el, j) => el.classList.toggle('selected', j === this.selected));
    if (this.menuOpen) this.items[this.selected].focus({ preventScroll: true });
  }

  choose(i) {
    this.select(i);
    if (this.onMenuSelect) this.onMenuSelect(this.items[i].dataset.item);
  }

  onKey(e) {
    if (this.menuOpen) {
      if (e.target instanceof Element && e.target.closest('#controls')) return;
      if (e.key === 'ArrowDown') this.select(this.selected + 1);
      else if (e.key === 'ArrowUp') this.select(this.selected - 1);
      else if (e.key === 'Enter') this.choose(this.selected);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && this.escHandler) {
      e.preventDefault();
      this.escHandler();
    }
  }

  setCard(className, ...kids) {
    this.hideMenu();
    this.card.className = `term-card ${className}`;
    this.card.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined));
    this.card.hidden = false;
  }

  clearCard() {
    this.card.hidden = true;
    this.card.replaceChildren();
    this.escHandler = null;
  }

  // Resolves trimmed text, or null on Esc
  prompt(label, { value = '', maxLength = 64, validate = null } = {}) {
    return new Promise((resolve) => {
      const input = h('input', { class: 'prompt-input', type: 'text', value, maxLength, spellcheck: false, autocomplete: 'off' });
      const error = h('p', { class: 'card-error', hidden: true });
      const finish = (v) => {
        this.escHandler = null;
        resolve(v);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = input.value.trim();
        const problem = validate ? validate(v) : (v ? null : 'REQUIRED');
        if (problem) {
          error.textContent = problem;
          error.hidden = false;
          return;
        }
        finish(v);
      });
      this.setCard('prompt-card',
        h('label', { class: 'prompt-line' }, h('span', { class: 'prompt-label' }, `${label} `), input),
        error,
        h('p', { class: 'card-hint' }, PROMPT_HINT));
      this.escHandler = () => finish(null);
      input.focus();
      input.select();
    });
  }

  showHosting(code, link, onCancel) {
    const copyCode = termButton('COPY CODE', () => copyText(code, copyCode));
    const copyLink = termButton('COPY LINK', () => copyText(link, copyLink));
    this.setCard('hosting-card',
      h('p', { class: 'card-kicker' }, 'ROOM CODE'),
      h('p', { class: 'room-code' }, code),
      h('p', { class: 'card-actions' }, copyCode, ' ', copyLink),
      h('p', { class: 'card-status' }, h('span', { class: 'ellipsis' }, 'AWAITING PEER')),
      h('p', { class: 'card-hint' }, 'ESC TO CANCEL'));
    this.escHandler = onCancel;
  }

  showConnecting(code, onCancel) {
    this.setCard('status-card',
      h('p', { class: 'card-status' }, h('span', { class: 'ellipsis' }, `CONNECTING TO ${code}`)),
      h('p', { class: 'card-hint' }, 'ESC TO CANCEL'));
    this.escHandler = onCancel;
  }

  showEstablished() {
    const line = h('p', { class: 'card-status big' }, 'LINK ESTABLISHED');
    this.setCard('status-card', line);
    return new Promise((resolve) => setTimeout(() => {
      // Only clear if nothing replaced it meanwhile
      if (line.isConnected) this.clearCard();
      resolve();
    }, ESTABLISHED_MS));
  }

  showNotice(text, hint = '') {
    this.setCard('status-card', h('p', { class: 'card-status big' }, text), hint ? h('p', { class: 'card-hint' }, hint) : null);
  }

  // actions: [{ label, fn }]; last one is Esc
  showFailure(title, hint, actions) {
    this.setCard('status-card',
      h('p', { class: 'card-status big' }, title),
      hint ? h('p', { class: 'card-hint wide' }, hint) : null,
      h('p', { class: 'card-actions' }, actions.flatMap((a, i) => [i ? ' ' : null, termButton(a.label, a.fn)])));
    this.escHandler = actions[actions.length - 1].fn;
  }

  // Two-column copy-paste signaling panel
  showManual({ createOffer, acceptAnswer, acceptOffer, onBack }) {
    const codeBox = (readOnly) => h('textarea', { class: 'code-box', readOnly, spellcheck: false, placeholder: readOnly ? '' : 'PASTE CODE HERE' });
    const codeLabel = (text) => h('span', {}, text);

    const offerOut = codeBox(true);
    const offerLen = codeLabel('');
    const copyOffer = termButton('COPY', () => copyText(offerOut.value, copyOffer), { disabled: true });
    const answerIn = codeBox(false);
    const callerStatus = h('p', { class: 'card-hint left' });
    const connect = termButton('CONNECT', async () => {
      connect.disabled = true;
      try {
        await acceptAnswer(answerIn.value);
        callerStatus.textContent = 'ANSWER ACCEPTED. LINKING...';
      } catch (err) {
        callerStatus.textContent = err.message;
        connect.disabled = false;
      }
    }, { disabled: true });
    const create = termButton('CREATE OFFER', async () => {
      create.disabled = true;
      offerIn.disabled = true;
      acceptBtn.disabled = true;
      callerStatus.textContent = 'GATHERING NETWORK ROUTES...';
      try {
        offerOut.value = await createOffer();
        offerLen.textContent = ` · ${offerOut.value.length} CHARS`;
        copyOffer.disabled = false;
        connect.disabled = false;
        callerStatus.textContent = 'SEND THE OFFER, THEN PASTE THEIR ANSWER.';
      } catch (err) {
        callerStatus.textContent = err.message;
      }
    });

    const offerIn = codeBox(false);
    const answerOut = codeBox(true);
    const answerLen = codeLabel('');
    const copyAnswer = termButton('COPY', () => copyText(answerOut.value, copyAnswer), { disabled: true });
    const calleeStatus = h('p', { class: 'card-hint left' });
    const acceptBtn = termButton('CREATE ANSWER', async () => {
      acceptBtn.disabled = true;
      create.disabled = true;
      calleeStatus.textContent = 'GATHERING NETWORK ROUTES...';
      try {
        answerOut.value = await acceptOffer(offerIn.value);
        answerLen.textContent = ` · ${answerOut.value.length} CHARS`;
        copyAnswer.disabled = false;
        calleeStatus.textContent = 'SEND THIS ANSWER BACK TO THE CALLER.';
      } catch (err) {
        calleeStatus.textContent = err.message;
        acceptBtn.disabled = false;
        create.disabled = false;
      }
    });

    this.setCard('manual-card',
      h('p', { class: 'card-kicker' }, 'MANUAL CONNECT'),
      h('div', { class: 'manual-cols' },
        h('div', { class: 'manual-col' },
          h('p', { class: 'col-title' }, 'I AM CALLING'),
          h('p', {}, '1. ', create),
          h('p', {}, 'OFFER CODE', offerLen, ' ', copyOffer),
          offerOut,
          h('p', {}, '2. PASTE ANSWER CODE'),
          answerIn,
          h('p', {}, connect),
          callerStatus),
        h('div', { class: 'manual-col' },
          h('p', { class: 'col-title' }, 'I WAS CALLED'),
          h('p', {}, '1. PASTE OFFER CODE'),
          offerIn,
          h('p', {}, acceptBtn),
          h('p', {}, '2. ANSWER CODE', answerLen, ' ', copyAnswer),
          answerOut,
          calleeStatus)),
      h('p', { class: 'card-actions' }, termButton('BACK', onBack)),
      h('p', { class: 'card-hint' }, 'NO SERVER: CODES CARRY THE CONNECTION DETAILS DIRECTLY.'));
    this.escHandler = onBack;
  }
}
