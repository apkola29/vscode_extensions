// @ts-check
'use strict';

const vscode = require('vscode');
const { KeepAwake } = require('./keepAwake');
const { ActivityCoordinator } = require('./activityCoordinator');

const SECTION = 'agentKeepAwake';
const NAME = 'Agent Keep-Awake';
const HOUR_MS = 60 * 60_000;
const DURATION_ERROR = 'Keep Awake: Duration (Hours) must be a number from 0 to 24. Use 0 for until you turn it off.';
const AUTO_CAPABILITY = {
  status: /** @type {const} */ ('unavailable'),
  harness: 'VS Code Local/Copilot',
  reason: 'No native lifecycle/cancellation/correlation profile validated; use Keep awake.'
};
const WINDOWS_NOTE =
  'On Windows, protection also keeps the screen on to prevent idle Modern Standby. ' +
  'Use AC power for long runs; closing the lid, the power button, an explicit Sleep command, ' +
  'or device or organization policy can still put the computer to sleep.';

/**
 * @typedef {ReturnType<typeof normalize>} State
 *
 * @typedef {object} View
 * @property {string} text
 * @property {boolean} green
 * @property {'error' | 'warning' | undefined} background
 * @property {string[]} lines Mode and protection facts, without click guidance.
 * @property {string} hint
 * @property {string} label Screen-reader label.
 */

/** @param {unknown} hours @returns {hours is number} */
function validHours(hours) {
  return typeof hours === 'number' && Number.isFinite(hours) &&
    hours >= 0 && hours <= 24 && (hours === 0 || Math.round(hours * HOUR_MS) > 0);
}

/** @param {number} at */
function formatTime(at) {
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** @param {unknown} value @param {string} [fallback] */
function textOf(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Errors can cross realms or arrive as plain objects, so read the message rather than test instanceof.
 * @param {unknown} error
 */
function messageOf(error) {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error);
}

/** @param {unknown} value */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Copies only the documented coordinator fields, so nothing else it holds can reach callers.
 * @param {Record<string, any>} raw
 */
function normalize(raw) {
  const auto = raw.auto && typeof raw.auto === 'object' ? raw.auto : {};
  return {
    mode: textOf(raw.mode, 'off'),
    state: textOf(raw.state, 'off'),
    desired: raw.desired === true,
    confirmed: raw.confirmed === true,
    ownerCount: countOf(raw.ownerCount),
    generation: countOf(raw.generation),
    instanceId: textOf(raw.instanceId),
    durationMs: countOf(raw.durationMs),
    expiresAt: countOf(raw.expiresAt),
    error: textOf(raw.error),
    notice: textOf(raw.notice),
    auto: { status: textOf(auto.status, 'unavailable'), harness: textOf(auto.harness), reason: textOf(auto.reason) },
    backendState: textOf(raw.backendState),
    pids: Array.isArray(raw.pids) ? raw.pids.filter(Number.isSafeInteger) : [],
    helpers: Array.isArray(raw.helpers) ? raw.helpers.filter(helper => typeof helper === 'string') : []
  };
}

/**
 * Everything the status item says, derived from one coordinator snapshot.
 * Green is reserved for a confirmed hold; every other state is neutral or a warning.
 * @param {State} s
 * @param {boolean} windows
 * @returns {View}
 */
function present(s, windows) {
  const auto = s.mode === 'auto';
  const mode = auto ? 'Auto - Copilot activity' : s.mode === 'manual' ? 'Keep awake' : 'Off';
  const subject = auto ? 'Auto' : 'Keep Awake';
  const reason = s.auto.reason || AUTO_CAPABILITY.reason;
  const when = s.expiresAt > 0 ? formatTime(s.expiresAt) : '';
  /** @type {string[]} */
  const lines = [];
  /** @type {View['background']} */
  let background;
  let text;
  let hint;
  let label;

  if (s.confirmed) {
    const timed = !auto && s.durationMs > 0;
    const span = timed ? `until ${when || 'its timer ends'}` : 'until you turn it off';
    text = '$(coffee)';
    if (auto) {
      lines.push(`Mode: ${mode}. On, confirmed. Your computer stays awake while tracked Copilot work is active (${s.ownerCount} tracked).`);
      if (s.state === 'limited') lines.push('Coverage is limited: only the Copilot work that can be observed is protected.');
    } else if (timed) {
      lines.push(`Mode: ${mode}. On, confirmed ${span}.`);
    } else {
      lines.push(`Mode: ${mode}. On, confirmed. Your computer stays awake until you turn it off or close this window. No expiry timer is running.`);
    }
    if (!auto) lines.push('Keep awake does not depend on Copilot, hooks, a model or a sign-in.');
    if (auto && when) lines.push(`Safeguard: protection for tracked work stops by ${when}, even though work may still be running.`);
    hint = 'Click to choose Off (allow sleep) or another mode. Off never cancels Copilot.';
    label = auto
      ? `${NAME}: ${mode} is on and confirmed. Tracked Copilot work is keeping your computer awake.`
      : `${NAME}: ${mode} is on and confirmed ${span}. Your computer is being kept awake.`;
  } else if (s.state === 'off') {
    text = '$(coffee) @awake ready';
    lines.push(`Mode: Off. ${NAME} is not holding any sleep request, so your computer can sleep. Other apps may still keep it awake.`);
    lines.push('Opening VS Code never turns this on.');
    if (s.auto.status === 'unavailable') lines.push('Auto - Copilot activity is unavailable in this build.');
    else if (s.auto.status === 'limited') lines.push('Auto - Copilot activity has limited coverage in this build.');
    hint = 'Click to choose Keep awake (until you turn it off) or Auto.';
    label = `${NAME}: Off. Your computer can sleep. Click to choose a mode.`;
  } else if (s.state === 'starting' || s.state === 'on') {
    text = `$(sync~spin) ${subject}: Starting...`;
    lines.push(`Mode: ${mode}. Starting. Sleep protection is not confirmed yet, so your computer is not protected until the icon turns green.`);
    hint = 'Click to choose Off to cancel.';
    label = `${NAME}: ${mode} is starting. Protection is not confirmed yet.`;
  } else if (s.state === 'failed') {
    text = `$(warning) ${subject}: Failed`;
    background = 'error';
    lines.push(`Mode: ${mode}. Failed. Sleep protection is not on, so your computer can sleep.`);
    hint = 'Click to choose Off, then Keep awake to try again.';
    label = `${NAME}: ${mode} failed. Your computer can sleep.`;
  } else if (s.state === 'unverified') {
    text = `$(warning) ${subject}: Unverified`;
    background = 'warning';
    lines.push(`Mode: ${mode}. Unverified. This operating system has not confirmed the sleep request, so it may not prevent sleep.`);
    hint = 'Do not rely on it. Click to choose Off or another mode.';
    label = `${NAME}: ${mode} is unverified. The operating system has not confirmed sleep protection.`;
  } else if (s.state === 'unavailable') {
    text = '$(warning) Auto: Unavailable';
    background = 'warning';
    lines.push(`Mode: Auto - Copilot activity. Unavailable. ${reason}`, 'Nothing is keeping your computer awake.');
    hint = 'Click to choose Keep awake instead, or Off.';
    label = `${NAME}: Auto is unavailable. Your computer can sleep. Choose Keep awake instead.`;
  } else if (s.state === 'limited') {
    text = '$(warning) Auto: Limited';
    background = 'warning';
    lines.push('Mode: Auto - Copilot activity. Limited. Only the Copilot work that can be observed is protected, and some cases are not covered. Use Keep awake to cover everything.');
    hint = 'Click to choose Keep awake or Off.';
    label = `${NAME}: Auto has limited coverage. Your computer can sleep unless tracked work is active.`;
  } else if (s.state === 'waiting') {
    text = '$(coffee) Auto: Waiting';
    lines.push('Mode: Auto - Copilot activity. Waiting. No tracked Copilot work is active, so no sleep request is held yet. Chats that were already running are not covered.');
    hint = 'Click to choose Keep awake or Off.';
    label = `${NAME}: Auto is waiting for Copilot activity. Nothing is protecting your computer right now.`;
  } else {
    text = `$(warning) ${subject}: Unknown`;
    background = 'warning';
    lines.push(`Mode: ${mode}. State "${s.state}" is not recognised, so protection is not confirmed.`);
    hint = 'Click to choose Off or Keep awake.';
    label = `${NAME}: unknown state. Protection is not confirmed.`;
  }

  if (auto) lines.push(`Harness: ${s.auto.harness || 'unknown'}.`);
  if (s.error) lines.push(`Error: ${s.error}`);
  if (s.notice && !lines.join(' ').includes(s.notice)) lines.push(`Notice: ${s.notice}`);
  if (windows) lines.push(WINDOWS_NOTE);
  return { text, green: s.confirmed, background, lines, hint, label };
}

/** @param {State} s */
function autoUnavailableMessage(s) {
  const reason = s.auto.reason || AUTO_CAPABILITY.reason;
  if (s.mode === 'manual' && s.state !== 'off') {
    return `Auto - Copilot activity is unavailable. ${reason} Keep awake is still on and was not changed. Choose Turn Off to release it.`;
  }
  if (s.state === 'limited') {
    return `Auto - Copilot activity has limited coverage. ${reason} It protects only the work it can observe. Choose Keep awake to cover everything until you turn it off.`;
  }
  return `Auto - Copilot activity is unavailable. ${reason} Nothing is keeping your computer awake. Choose Keep awake to protect it until you turn it off.`;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  /** @type {string} */
  const version = context.extension.packageJSON.version;
  const log = vscode.window.createOutputChannel(NAME, { log: true });
  /** @param {'debug' | 'info' | 'warn' | 'error'} level @param {string} message */
  const write = (level, message) => log[level](message);
  const windows = process.platform === 'win32';
  const coordinator = new ActivityCoordinator(new KeepAwake({ log: write }), {
    log: write,
    keepDisplayOn: windows,
    nativeAcknowledgement: windows,
    autoCapability: { ...AUTO_CAPABILITY }
  });
  const status = vscode.window.createStatusBarItem('agentKeepAwake.status', vscode.StatusBarAlignment.Right, 100);
  status.name = NAME;
  status.command = `${SECTION}.selectMode`;
  const green = new vscode.ThemeColor('testing.iconPassed');

  const state = () => normalize(coordinator.getState());

  /**
   * A toast resolves only when it is dismissed, so commands never await one.
   * @param {'info' | 'warn' | 'error'} level @param {string} message @param {string[]} [actions]
   * @returns {Promise<string | undefined>}
   */
  function notify(level, message, actions = []) {
    const shown = level === 'error' ? vscode.window.showErrorMessage(message, ...actions)
      : level === 'warn' ? vscode.window.showWarningMessage(message, ...actions)
        : vscode.window.showInformationMessage(message, ...actions);
    return Promise.resolve(shown).then(choice => choice, () => undefined);
  }

  /** @param {number} durationMs @returns {Promise<boolean>} */
  async function startManual(durationMs) {
    try {
      const confirmed = await coordinator.manual(durationMs);
      if (!confirmed) {
        const current = state();
        if (current.state === 'failed') {
          void notify('error', `Keep Awake could not start. Your computer can sleep.${current.error ? ` ${current.error}` : ''}`);
        }
      }
      return confirmed;
    } catch (error) {
      void notify('error', `Keep Awake could not start. Your computer can sleep. ${messageOf(error)}`);
      return false;
    }
  }

  function keepAwake() {
    return startManual(0);
  }

  function turnOff() {
    coordinator.off();
  }

  /** @returns {boolean} */
  function autoMode() {
    const armed = coordinator.auto();
    if (!armed) void notify('warn', autoUnavailableMessage(state()));
    return armed;
  }

  async function toggleSession() {
    if (state().mode === 'manual') {
      coordinator.off();
      return;
    }
    const hours = vscode.workspace.getConfiguration(SECTION).get('durationHours', 1);
    if (!validHours(hours)) {
      log.error(DURATION_ERROR);
      void notify('error', DURATION_ERROR);
      return;
    }
    await startManual(Math.round(hours * HOUR_MS));
  }

  async function chooseDuration() {
    const choice = await vscode.window.showQuickPick([
      { label: 'Keep awake for 1 hour', description: 'For a long Copilot or Claude prompt', durationMs: HOUR_MS },
      { label: 'Keep awake for 30 minutes', durationMs: 30 * 60_000 },
      { label: 'Keep awake for 2 hours', durationMs: 2 * HOUR_MS },
      { label: 'Keep awake for 4 hours', durationMs: 4 * HOUR_MS },
      { label: 'Until I turn it off', description: 'No expiry timer; still stops when this window closes', durationMs: 0 }
    ], {
      title: 'Keep Awake for a set time',
      placeHolder: 'Choose a time. Choose Off from the coffee icon to stop early.'
    });
    if (choice) await startManual(choice.durationMs);
  }

  async function selectMode() {
    const s = state();
    const timed = s.mode === 'manual' && s.durationMs > 0;
    /** @param {boolean} current @param {string} base */
    const describe = (current, base) => current ? (base ? `Current - ${base}` : 'Current') : base;
    /** @type {(vscode.QuickPickItem & { action: 'off' | 'keepAwake' | 'auto' | 'timed' })[]} */
    const items = [
      {
        label: '$(circle-slash) Off',
        description: describe(s.mode === 'off', 'Allow sleep'),
        detail: 'Stop this extension\'s sleep request. Other apps may still keep this computer awake. Never cancels Copilot.',
        action: 'off'
      },
      {
        label: '$(coffee) Keep awake',
        description: describe(s.mode === 'manual' && !timed, 'Until I turn it off'),
        detail: 'Prevent idle sleep for any activity until you turn it off or this window closes. No Copilot, hooks, model or sign-in needed.',
        action: 'keepAwake'
      },
      {
        label: '$(sparkle) Auto - Copilot activity',
        description: describe(s.mode === 'auto', s.auto.status === 'unavailable' ? 'Unavailable'
          : s.auto.status === 'limited' ? 'Limited coverage' : 'Available'),
        detail: s.auto.reason || AUTO_CAPABILITY.reason,
        action: 'auto'
      },
      {
        label: '$(clock) Keep awake for a set time...',
        description: describe(timed, '30 minutes to 4 hours'),
        detail: 'Starts a timed Keep awake session that ends by itself. Turn Off stops it early.',
        action: 'timed'
      }
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: NAME,
      placeHolder: 'Choose how this window keeps your computer awake'
    });
    if (choice?.action === 'off') turnOff();
    else if (choice?.action === 'keepAwake') await keepAwake();
    else if (choice?.action === 'auto') autoMode();
    else if (choice?.action === 'timed') await chooseDuration();
  }

  function showStatus() {
    const summary = present(state(), windows).lines.join(' ');
    void notify('info', summary, ['Show Log']).then(choice => {
      if (choice === 'Show Log') log.show(true);
    });
  }

  function render() {
    const view = present(state(), windows);
    status.text = view.text;
    status.tooltip = [...view.lines, view.hint].join('\n');
    status.color = view.green ? green : undefined;
    status.backgroundColor = view.background ? new vscode.ThemeColor(`statusBarItem.${view.background}Background`) : undefined;
    status.command = `${SECTION}.selectMode`;
    status.accessibilityInformation = { label: view.label, role: 'button' };
    if (vscode.workspace.getConfiguration(SECTION).get('showStatusBarItem') === false) {
      status.hide();
    } else {
      status.show();
    }
  }

  coordinator.on('change', render);
  log.info(`Keep Awake ${version} loaded. Off is the default: nothing holds a sleep request until you choose Keep awake. Auto - Copilot activity is unavailable in this build.`);
  if (windows) {
    log.info('Windows protection keeps the screen on as well as requesting system activity for Modern Standby. Use AC power for long runs; forced sleep and device policies can still override power requests.');
  }

  context.subscriptions.push(
    // ActivityCoordinator.off() is the Off mode and shadows EventEmitter.off, so unsubscribe with removeListener.
    { dispose: () => { coordinator.removeListener('change', render); } },
    coordinator,
    status,
    log,
    vscode.commands.registerCommand(`${SECTION}.selectMode`, selectMode),
    vscode.commands.registerCommand(`${SECTION}.keepAwake`, keepAwake),
    vscode.commands.registerCommand(`${SECTION}.autoMode`, autoMode),
    vscode.commands.registerCommand(`${SECTION}.turnOff`, turnOff),
    vscode.commands.registerCommand(`${SECTION}.toggleSession`, toggleSession),
    vscode.commands.registerCommand(`${SECTION}.chooseDuration`, chooseDuration),
    vscode.commands.registerCommand(`${SECTION}.openSettings`, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:apkola29.agent-keep-awake duration')),
    vscode.commands.registerCommand(`${SECTION}.stopSession`, turnOff),
    vscode.commands.registerCommand(`${SECTION}.showStatus`, showStatus),
    vscode.commands.registerCommand(`${SECTION}.showLog`, () => log.show(true)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(SECTION)) render();
    })
  );
  render();

  return {
    startKeepAwake: (/** @type {number} */ durationMs) => coordinator.manual(durationMs),
    stopKeepAwake: () => coordinator.off(),
    getState() {
      return {
        ...state(),
        supported: true,
        version,
        keepsDisplayOn: windows,
        statusText: status.text,
        statusColor: status.color instanceof vscode.ThemeColor ? status.color.id : status.color
      };
    }
  };
}

module.exports = { activate };
