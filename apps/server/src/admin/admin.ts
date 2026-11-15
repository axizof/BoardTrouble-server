/// <reference lib="dom" />
import type { BotLevel, RoomSettings } from '@board-trouble/core';
import type { AdminInbound, AdminOutbound, AdminState, Preset } from './adminProtocol';

// La page du tableau de bord (servie par le serveur sur `/admin`) : cinq onglets, sobres. Elle
// lit l'état que le serveur pousse toutes les deux secondes et le journal en direct ; ce qui est
// irréversible (forcer, fermer, bannir, arrêter) demande confirmation. Tout texte venu des joueurs
// est échappé avant d'être affiché.

type Tab = 'overview' | 'rooms' | 'players' | 'console' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: "Vue d'ensemble" },
  { id: 'rooms', label: 'Salons' },
  { id: 'players', label: 'Joueurs' },
  { id: 'console', label: 'Console' },
  { id: 'settings', label: 'Réglages' },
];
const LEVEL_NAMES: Record<BotLevel, string> = {
  easy: 'Facile',
  normal: 'Normal',
  expert: 'Expert',
};
const LOG_KEPT = 1000;

const view = {
  tab: 'overview' as Tab,
  isConnected: false,
  needsLogin: false,
  state: null as AdminState | null,
  logs: [] as string[],
  confirm: null as { text: string; action: AdminInbound } | null,
  toast: null as { text: string; isError: boolean } | null,
};

const app = document.getElementById('app') as HTMLElement;
let socket: WebSocket | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function send(message: AdminInbound): void {
  socket?.send(JSON.stringify(message));
}

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/admin/ws`);
  socket.addEventListener('open', () => {
    view.isConnected = true;
    render();
  });
  socket.addEventListener('close', () => {
    view.isConnected = false;
    render();
    // Le serveur redémarre, ou la liaison a sauté : on réessaie.
    setTimeout(connect, 2000);
  });
  socket.addEventListener('message', (event) => {
    receive(JSON.parse(String(event.data)) as AdminOutbound);
  });
}

function receive(message: AdminOutbound): void {
  switch (message.type) {
    case 'auth':
      view.needsLogin = !message.ok;
      break;
    case 'state':
      view.state = message.state;
      break;
    case 'logs':
      view.logs = [...view.logs, ...message.lines].slice(-LOG_KEPT);
      if (view.tab === 'console') {
        appendLogs(message.lines);
        return;
      }
      break;
    case 'notice':
      showToast(message.text, message.isError);
      return;
  }
  render();
}

function showToast(text: string, isError: boolean): void {
  view.toast = { text, isError };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    view.toast = null;
    render();
  }, 3500);
  render();
}

// --- Le rendu --------------------------------------------------------------------------------

/** Garde ce que l'on est en train de taper d'un rendu à l'autre (l'état arrive toutes les 2 s). */
function render(): void {
  const focused = document.activeElement;
  const keep =
    focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement
      ? focused.name
      : null;
  const values = new Map(
    [...app.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')].map((field) => [
      field.name,
      field.value,
    ]),
  );
  const scroll = app.querySelector('.console')?.scrollTop;
  app.innerHTML = view.needsLogin ? loginPage() : page();
  for (const field of app.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')) {
    const value = values.get(field.name);
    if (value !== undefined && !(field instanceof HTMLInputElement && field.type === 'checkbox')) {
      field.value = value;
    }
  }
  if (keep) app.querySelector<HTMLElement>(`[name="${keep}"]`)?.focus();
  const console_ = app.querySelector('.console');
  if (console_) console_.scrollTop = scroll ?? console_.scrollHeight;
}

function appendLogs(lines: string[]): void {
  const console_ = app.querySelector('.console');
  if (!console_) return;
  const isAtBottom = console_.scrollHeight - console_.scrollTop - console_.clientHeight < 40;
  console_.append(...lines.map((line) => `${line}\n`));
  if (isAtBottom) console_.scrollTop = console_.scrollHeight;
}

function loginPage(): string {
  return `<div class="login"><form class="card" data-form="login">
    <h2>Tableau de bord</h2>
    <p class="muted">Le mot de passe admin est affiché dans la console du serveur au lancement
    (ou fixé par la variable BT_ADMIN_PASSWORD).</p>
    <div class="form"><label class="field">Mot de passe
      <input name="password" type="password" autocomplete="current-password" required /></label>
      <button class="button is-primary" type="submit">Entrer</button></div>
  </form></div>${toast()}`;
}

function page(): string {
  const { state } = view;
  const counts: Partial<Record<Tab, number>> = state
    ? { rooms: state.rooms.length, players: state.players.length }
    : {};
  return `<div class="layout">
    <header class="top">
      <h1>${escapeHtml(state?.server.name ?? 'Board Trouble')}<small>${state ? `version ${escapeHtml(state.server.version)}` : ''}</small></h1>
      <span class="pill${view.isConnected ? '' : ' is-off'}">${view.isConnected ? `En ligne depuis ${duration(state?.server.uptime ?? 0)}` : 'Hors ligne, reconnexion...'}</span>
    </header>
    <nav class="tabs" role="tablist">${TABS.map(
      (tab) =>
        `<button role="tab" data-tab="${tab.id}" aria-selected="${view.tab === tab.id}">${tab.label}${counts[tab.id] !== undefined ? `<span class="count">${counts[tab.id]}</span>` : ''}</button>`,
    ).join('')}</nav>
    ${state ? tabContent(state) : '<p class="empty">Connexion au serveur...</p>'}
  </div>${confirmBox()}${toast()}`;
}

function tabContent(state: AdminState): string {
  switch (view.tab) {
    case 'overview':
      return overview(state);
    case 'rooms':
      return rooms(state);
    case 'players':
      return players(state);
    case 'console':
      return `<pre class="console">${escapeHtml(view.logs.join('\n'))}\n</pre>`;
    case 'settings':
      return settings(state);
  }
}

function overview({ server, rooms, players }: AdminState): string {
  const { stats } = server;
  const memory = Math.round(stats.memory / 1024 / 1024);
  const share = Math.min(100, (stats.memory / stats.totalMemory) * 100);
  const playing = rooms.filter((room) => room.view.phase === 'playing').length;
  return `${
    server.update
      ? `<div class="banner"><strong>Version ${escapeHtml(server.update.version)} disponible.</strong> ${escapeHtml(server.update.notes)}</div>`
      : ''
  }<div class="grid">
    ${stat(String(players.length), plural(players.length, 'joueur connecté', 'joueurs connectés'))}
    ${stat(String(rooms.length), `${plural(rooms.length, 'salon', 'salons')}, dont ${playing} en partie`)}
    ${stat(`${stats.cpu} %`, `processeur (un cœur sur ${stats.cores})`, Math.min(100, stats.cpu))}
    ${stat(`${memory} Mo`, 'mémoire du serveur', share)}
  </div>
  <section class="card"><h2>Adresses à donner aux joueurs</h2>
    <table><tbody>
      <tr><td>Sur cette machine</td><td><a href="http://localhost:${server.port}" target="_blank">http://localhost:${server.port}</a></td></tr>
      ${server.addresses.map((address) => `<tr><td>Réseau local</td><td>${escapeHtml(address)}</td></tr>`).join('')}
    </tbody></table>
    <p class="muted">Par Internet : un VPS (son adresse et ce port), ou un tunnel vers ce port.</p>
  </section>`;
}

function stat(value: string, label: string, bar?: number): string {
  return `<div class="card stat"><strong>${value}</strong><span>${label}</span>${
    bar === undefined ? '' : `<div class="bar"><i style="width:${bar.toFixed(0)}%"></i></div>`
  }</div>`;
}

function rooms(state: AdminState): string {
  const create = `<section class="card"><h2>Nouveau salon</h2>
    <form class="form" data-form="createRoom">
      <label class="field">Nom<input name="roomName" required minlength="3" maxlength="24" /></label>
      <label class="field">Mot de passe (facultatif)<input name="roomPassword" maxlength="64" /></label>
      <label class="field">Preset<select name="roomPreset"><option value="">Par défaut</option>${state.presets
        .map(
          (preset) =>
            `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`,
        )
        .join('')}</select></label>
      <button class="button is-primary" type="submit">Créer</button>
    </form>
    <p class="muted">Le premier joueur qui entre en devient l'hôte.</p></section>`;
  if (state.rooms.length === 0) {
    return `${create}<section class="card"><p class="empty">Aucun salon ouvert.</p></section>`;
  }
  return create + state.rooms.map((room) => roomCard(room, state)).join('');
}

function roomCard({ view: room, step }: AdminState['rooms'][number], state: AdminState): string {
  const isPlaying = room.phase === 'playing';
  const rows = room.seats
    .map((seat, index) => {
      const member = room.members.find((one) => one.id === seat.member);
      const who = member
        ? `${escapeHtml(member.name)}${member.id === room.hostId ? ' <span class="badge">hôte</span>' : ''}`
        : `<span class="muted">Bot ${LEVEL_NAMES[seat.botLevel]}</span>`;
      const status = !member
        ? ''
        : !member.isConnected
          ? 'déconnecté'
          : seat.isAway
            ? 'absent (un bot joue)'
            : 'présent';
      const ping = state.players.find((one) => one.id === member?.id)?.ping;
      return `<tr><td>${index + 1}</td><td>${who}</td><td class="muted">${status}</td><td class="muted">${ping == null ? '' : `${ping} ms`}</td></tr>`;
    })
    .join('');
  const watching = room.members.filter(
    (member) => !room.seats.some((seat) => seat.member === member.id),
  );
  return `<section class="card">
    <div class="card-head">
      <h2>${escapeHtml(room.name)}<small>${escapeHtml(room.id)}${room.hasPassword ? ' : mot de passe' : ''}</small></h2>
      <span class="badge${isPlaying ? ' is-playing' : ''}">${isPlaying ? escapeHtml(step ?? 'En partie') : 'Au salon'}</span>
    </div>
    <table><thead><tr><th>Place</th><th>Joueur</th><th>État</th><th>Ping</th></tr></thead><tbody>${rows}</tbody></table>
    ${watching.length > 0 ? `<p class="muted">Regardent : ${watching.map((member) => escapeHtml(member.name)).join(', ')}</p>` : ''}
    <p class="muted">${room.settings.tableSize} joueurs, chaos ${room.settings.chaos}, ${room.settings.decisionTime / 1000} s pour décider.</p>
    <div>${
      isPlaying
        ? `<button class="button" data-confirm="forceNext" data-room="${escapeHtml(room.id)}">Forcer l'étape suivante</button>`
        : ''
    }<button class="button is-danger" data-confirm="closeRoom" data-room="${escapeHtml(room.id)}">Fermer le salon</button></div>
  </section>`;
}

function players(state: AdminState): string {
  const roomName = (id: string | null) =>
    id === null
      ? '<span class="muted">aucun</span>'
      : escapeHtml(state.rooms.find((room) => room.view.id === id)?.view.name ?? id);
  const list =
    state.players.length === 0
      ? '<p class="empty">Personne n\'est connecté.</p>'
      : `<table><thead><tr><th>Pseudo</th><th>Salon</th><th>Ping</th><th>Adresse</th><th></th></tr></thead><tbody>${state.players
          .map(
            (player) => `<tr><td>${escapeHtml(player.name)}</td><td>${roomName(player.roomId)}</td>
              <td>${player.ping === null ? '<span class="muted">...</span>' : `${player.ping} ms`}</td>
              <td class="muted">${escapeHtml(player.address)}</td>
              <td class="actions"><button class="button" data-confirm="kick" data-id="${escapeHtml(player.id)}" data-name="${escapeHtml(player.name)}">Expulser</button><button class="button is-danger" data-confirm="ban" data-id="${escapeHtml(player.id)}" data-name="${escapeHtml(player.name)}">Bannir</button></td></tr>`,
          )
          .join('')}</tbody></table>`;
  const bans =
    state.bans.length === 0
      ? '<p class="empty">Personne n\'est banni.</p>'
      : `<table><tbody>${state.bans
          .map(
            (ban) =>
              `<tr><td>${escapeHtml(ban.name)}</td><td class="actions"><button class="button" data-action="unban" data-id="${escapeHtml(ban.id)}">Débannir</button></td></tr>`,
          )
          .join('')}</tbody></table>`;
  return `<section class="card"><h2>Connectés</h2>${list}</section>
    <section class="card"><h2>Bannis du serveur<small>gardés après un redémarrage</small></h2>${bans}</section>`;
}

function settings(state: AdminState): string {
  const presets =
    state.presets.length === 0
      ? '<p class="empty">Aucun preset pour l\'instant.</p>'
      : `<table><tbody>${state.presets
          .map(
            (preset) =>
              `<tr><td>${escapeHtml(preset.name)}</td><td class="muted">${describe(preset.settings)}${
                preset.botLevels.length > 0
                  ? `, bots ${preset.botLevels.map((level) => LEVEL_NAMES[level]).join(', ')}`
                  : ''
              }</td><td class="actions"><button class="button is-danger" data-action="deletePreset" data-name="${escapeHtml(preset.name)}">Supprimer</button></td></tr>`,
          )
          .join('')}</tbody></table>`;
  const select = (name: string, options: [string, string][]) =>
    `<select name="${name}">${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`;
  const levels: [string, string][] = [
    ['normal', 'Normal'],
    ['easy', 'Facile'],
    ['expert', 'Expert'],
  ];
  return `<section class="card"><h2>Presets de salon<small>des réglages tout prêts, pour créer un salon d'un clic</small></h2>
    ${presets}
    <form class="form" data-form="savePreset" style="margin-top:14px">
      <label class="field">Nom<input name="presetName" required minlength="3" maxlength="24" /></label>
      <label class="field">Table${select('presetTable', [
        ['4', '4 joueurs'],
        ['6', '6 joueurs'],
      ])}</label>
      <label class="field">Chaos${select('presetChaos', [
        ['normal', 'Normal'],
        ['calm', 'Calme'],
        ['trouble', 'Trouble'],
      ])}</label>
      <label class="field">Pour décider${select('presetTime', [
        ['90000', '90 s'],
        ['60000', '60 s'],
        ['120000', '120 s'],
        ['180000', '180 s'],
      ])}</label>
      <label class="field">Texte${select('presetSpeed', [
        ['normal', 'Normal'],
        ['slow', 'Lent'],
        ['fast', 'Rapide'],
        ['instant', 'Immédiat'],
      ])}</label>
      <label class="field">Conseils${select('presetTips', [
        ['yes', 'Oui'],
        ['no', 'Non'],
      ])}</label>
      <label class="field">Bots${select('presetBots', levels)}</label>
      <button class="button is-primary" type="submit">Enregistrer</button>
    </form></section>
    <section class="card"><h2>Le serveur</h2>
      <p class="muted">Arrêter ou redémarrer coupe les parties en cours (elles ne sont pas encore sauvegardées côté serveur).</p>
      <button class="button" data-confirm="restart">Redémarrer</button><button class="button is-danger" data-confirm="stop">Arrêter</button>
    </section>`;
}

function describe(settings: RoomSettings): string {
  return `${settings.tableSize} joueurs, chaos ${settings.chaos}, ${settings.decisionTime / 1000} s`;
}

function confirmBox(): string {
  if (!view.confirm) return '';
  return `<div class="modal"><div class="card"><p>${escapeHtml(view.confirm.text)}</p>
    <div class="row"><button class="button" data-action="cancel">Annuler</button>
    <button class="button is-primary" data-action="confirm">Confirmer</button></div></div></div>`;
}

function toast(): string {
  return view.toast
    ? `<div class="toast${view.toast.isError ? ' is-error' : ''}">${escapeHtml(view.toast.text)}</div>`
    : '';
}

function plural(count: number, one: string, many: string): string {
  return count > 1 ? many : one;
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} jours`;
}

// --- Les actions -----------------------------------------------------------------------------

/** Ce qui demande confirmation : le texte, et le message à envoyer une fois confirmé. */
function confirmation(button: HTMLElement): { text: string; action: AdminInbound } | null {
  const { confirm, room, id, name } = button.dataset;
  switch (confirm) {
    case 'forceNext':
      return room
        ? {
            text: "Forcer l'étape suivante ? Le joueur attendu joue son choix par défaut tout de suite (ou le mini-jeu passe à son étape suivante).",
            action: { type: 'forceNext', roomId: room },
          }
        : null;
    case 'closeRoom':
      return room
        ? {
            text: 'Fermer ce salon ? La partie en cours sera perdue.',
            action: { type: 'closeRoom', roomId: room },
          }
        : null;
    case 'kick':
      return id
        ? {
            text: `Expulser ${name} de son salon ? Il pourra revenir.`,
            action: { type: 'expel', id, isBanned: false },
          }
        : null;
    case 'ban':
      return id
        ? {
            text: `Bannir ${name} de tout le serveur ? Il ne pourra plus se connecter.`,
            action: { type: 'expel', id, isBanned: true },
          }
        : null;
    case 'restart':
      return {
        text: 'Redémarrer le serveur ? Les parties en cours seront perdues.',
        action: { type: 'restart' },
      };
    case 'stop':
      return {
        text: 'Arrêter le serveur ? Plus personne ne pourra jouer.',
        action: { type: 'stop' },
      };
    default:
      return null;
  }
}

app.addEventListener('click', (event) => {
  const target =
    event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button') : null;
  if (!target) return;
  if (target.dataset.tab) {
    view.tab = target.dataset.tab as Tab;
    render();
    return;
  }
  const asked = confirmation(target);
  if (asked) {
    view.confirm = asked;
    render();
    return;
  }
  switch (target.dataset.action) {
    case 'cancel':
      view.confirm = null;
      break;
    case 'confirm':
      if (view.confirm) send(view.confirm.action);
      view.confirm = null;
      break;
    case 'unban':
      if (target.dataset.id) send({ type: 'unban', id: target.dataset.id });
      break;
    case 'deletePreset':
      if (target.dataset.name) send({ type: 'deletePreset', name: target.dataset.name });
      break;
    default:
      return;
  }
  render();
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  const value = (name: string) => String(data.get(name) ?? '');
  switch (form.dataset.form) {
    case 'login':
      send({ type: 'login', password: value('password') });
      break;
    case 'createRoom':
      send({
        type: 'createRoom',
        name: value('roomName').trim(),
        password: value('roomPassword') || null,
        preset: value('roomPreset') || null,
      });
      form.reset();
      break;
    case 'savePreset': {
      const level = value('presetBots') as BotLevel;
      const preset: Preset = {
        name: value('presetName').trim(),
        settings: {
          tableSize: value('presetTable') === '6' ? 6 : 4,
          chaos: value('presetChaos') as RoomSettings['chaos'],
          decisionTime: Number(value('presetTime')),
          textSpeed: value('presetSpeed') as RoomSettings['textSpeed'],
          tips: value('presetTips') === 'yes',
        },
        botLevels: Array.from({ length: 6 }, () => level),
      };
      send({ type: 'savePreset', preset });
      form.reset();
      break;
    }
  }
});

render();
connect();
