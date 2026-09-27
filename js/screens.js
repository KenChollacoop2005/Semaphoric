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
    if (this.cardKeys && this.cardKeys(e)) {
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
    this.cardKeys = null;
    this.card.className = `term-card ${className}`;
    this.card.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined));
    this.card.hidden = false;
  }

  clearCard() {
    this.card.hidden = true;
    this.card.replaceChildren();
    this.escHandler = null;
    this.cardKeys = null;
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
  showFailure(title, hint, actions, detail = '') {
    this.setCard('status-card',
      h('p', { class: 'card-status big' }, title),
      hint ? h('p', { class: 'card-hint wide' }, hint) : null,
      detail ? h('p', { class: 'card-detail' }, detail) : null,
      h('p', { class: 'card-actions' }, actions.flatMap((a, i) => [i ? ' ' : null, termButton(a.label, a.fn)])));
    this.escHandler = actions[actions.length - 1].fn;
  }

  // Menu-style list in a card: [{ label, hint, fn }]
  showChoice(kicker, intro, options, onBack) {
    const hint = h('p', { class: 'card-hint wide choice-hint' });
    let selected = 0;
    const buttons = options.map((o, i) => h('button', {
      class: 'menu-item', type: 'button',
      onclick: () => o.fn(),
      onmouseenter: () => select(i),
    }, o.label));
    const select = (i) => {
      selected = (i + options.length) % options.length;
      buttons.forEach((b, j) => b.classList.toggle('selected', j === selected));
      hint.textContent = options[selected].hint;
      buttons[selected].focus({ preventScroll: true });
    };
    this.setCard('choice-card',
      h('p', { class: 'card-kicker' }, kicker),
      h('p', { class: 'card-hint wide' }, intro),
      buttons,
      hint,
      h('p', { class: 'card-hint' }, '↑↓ + ENTER · ESC TO GO BACK'));
    this.cardKeys = (e) => {
      if (e.key === 'ArrowDown') select(selected + 1);
      else if (e.key === 'ArrowUp') select(selected - 1);
      else if (e.key === 'Enter') options[selected].fn();
      else return false;
      return true;
    };
    this.escHandler = onBack;
    select(0);
  }

  // One numbered step; later steps start dimmed
  step(n, total, title, ...body) {
    return h('div', { class: 'step pending' },
      h('p', { class: 'step-title' }, `STEP ${n} OF ${total}  `, h('span', {}, title)),
      body);
  }

  // Person starting the call: invite out, reply in
  showManualCaller({ createOffer, acceptAnswer, onBack }) {
    const invite = h('textarea', { class: 'code-box', readOnly: true, spellcheck: false });
    const inviteLen = h('span', { class: 'dim' });
    const copy = termButton('COPY INVITE CODE', () => copyText(invite.value, copy));
    const reply = h('textarea', { class: 'code-box', spellcheck: false, placeholder: 'PASTE YOUR FRIEND\'S REPLY CODE HERE' });
    const status1 = h('p', { class: 'card-error' });
    const status3 = h('p', { class: 'card-hint left' });

    const generate = termButton('GENERATE INVITE CODE', async () => {
      generate.disabled = true;
      status1.textContent = '';
      try {
        invite.value = await createOffer();
        inviteLen.textContent = `  ${invite.value.length} CHARS`;
        s1.classList.add('done');
        s2.classList.remove('pending');
        s3.classList.remove('pending');
        reply.focus();
      } catch (err) {
        status1.textContent = err.message;
        generate.disabled = false;
      }
    });
    const connect = termButton('CONNECT', async () => {
      connect.disabled = true;
      status3.textContent = '';
      try {
        await acceptAnswer(reply.value);
        status3.replaceChildren(h('span', { class: 'ellipsis' }, 'CONNECTING'));
      } catch (err) {
        status3.textContent = err.message;
        connect.disabled = false;
      }
    });

    const s1 = this.step(1, 3, 'CREATE YOUR INVITE CODE',
      h('p', { class: 'step-text' }, 'The code holds the details your friend\'s browser needs to reach yours. It contains no video or personal info.'),
      h('p', {}, generate), status1);
    const s2 = this.step(2, 3, 'SEND IT TO YOUR FRIEND',
      h('p', {}, copy, inviteLen), invite,
      h('p', { class: 'step-text' }, 'Send it any way you like: text, email, chat. Tell them to open Semaphoric, pick MANUAL CONNECT, then MY FRIEND SENT ME A CODE, and paste it in. They will get a reply code to send back to you.'));
    const s3 = this.step(3, 3, 'PASTE THEIR REPLY CODE',
      reply, h('p', {}, connect), status3);
    s1.classList.remove('pending');

    this.setCard('manual-card',
      h('p', { class: 'card-kicker' }, 'MANUAL CONNECT · STARTING THE CALL'),
      s1, s2, s3,
      h('p', { class: 'card-actions' }, termButton('BACK', onBack)));
    this.escHandler = onBack;
  }

  // Person receiving: invite in, reply out
  showManualCallee({ acceptOffer, onBack }) {
    const invite = h('textarea', { class: 'code-box', spellcheck: false, placeholder: 'PASTE YOUR FRIEND\'S INVITE CODE HERE' });
    const reply = h('textarea', { class: 'code-box', readOnly: true, spellcheck: false });
    const replyLen = h('span', { class: 'dim' });
    const copy = termButton('COPY REPLY CODE', () => copyText(reply.value, copy));
    const status1 = h('p', { class: 'card-error' });

    const create = termButton('CREATE REPLY CODE', async () => {
      create.disabled = true;
      status1.textContent = '';
      try {
        reply.value = await acceptOffer(invite.value);
        replyLen.textContent = `  ${reply.value.length} CHARS`;
        invite.readOnly = true;
        s1.classList.add('done');
        s2.classList.remove('pending');
      } catch (err) {
        status1.textContent = err.message;
        create.disabled = false;
      }
    });

    const s1 = this.step(1, 2, 'PASTE YOUR FRIEND\'S INVITE CODE',
      h('p', { class: 'step-text' }, 'Your friend picked STARTING THE CALL and sent you a long code. Paste all of it here.'),
      invite, h('p', {}, create), status1);
    const s2 = this.step(2, 2, 'SEND THIS REPLY CODE BACK',
      h('p', {}, copy, replyLen), reply,
      h('p', { class: 'step-text' }, 'Send it back the same way. The call connects on its own as soon as they paste it. Keep this screen open.'),
      h('p', { class: 'card-hint left' }, h('span', { class: 'ellipsis' }, 'WAITING FOR YOUR FRIEND')));
    s1.classList.remove('pending');

    this.setCard('manual-card',
      h('p', { class: 'card-kicker' }, 'MANUAL CONNECT · ANSWERING A CALL'),
      s1, s2,
      h('p', { class: 'card-actions' }, termButton('BACK', onBack)));
    this.escHandler = onBack;
    invite.focus();
  }
}
