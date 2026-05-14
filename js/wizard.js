import { DFUDevice } from './dfu.js';

// ── OS detection ─────────────────────────────────────────────────────────────
function detectOS() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac'))     return 'macos';
  if (ua.includes('linux'))   return 'linux';
  return 'unknown';
}

// ── Step definitions ─────────────────────────────────────────────────────────
const STEP_COUNT    = 5; // steps 0–4
const STEP_PROGRESS = [0, 25, 50, 75, 100];

let transitioning = false;
let leaveTimer    = null;
let enterTimer    = null;

// ── Wizard state ─────────────────────────────────────────────────────────────
let currentStep = 0;
let dfuDevice   = null;
const os = detectOS();

// ── DOM refs ─────────────────────────────────────────────────────────────────
const progressFill   = document.getElementById('progressFill');
const pairBtn        = document.getElementById('pairBtn');
const pairNextBtn    = document.getElementById('pairNextBtn');
const pairIdle       = document.getElementById('pairIdle');
const pairConnected  = document.getElementById('pairConnected');
const pairHint       = document.getElementById('pairHint');
const pairHintMsg    = document.getElementById('pairHintMsg');
const deviceNameLbl  = document.getElementById('deviceNameLabel');
const cantSeeBtn     = document.getElementById('cantSeeBtn');
const driverHelp     = document.getElementById('driverHelp');
const driverHelpWin  = document.getElementById('driverHelpWin');
const driverHelpMac  = document.getElementById('driverHelpMac');
const exitBtn        = document.getElementById('exitBtn');
const exitStatus     = document.getElementById('exitStatus');
const restartBtn     = document.getElementById('restartBtn');
const successBurst   = document.getElementById('successBurst');

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  applyOSVariants();
  checkBrowserSupport();
  bindNavButtons();
  bindActions();
  renderStep(0, 'none');
}

function applyOSVariants() {
  if (os !== 'windows') {
    driverHelpWin.style.display = 'none';
    driverHelpMac.style.display = 'block';
  }
}

function checkBrowserSupport() {
  if (!navigator.usb) {
    const infoCard = document.querySelector('.card--info');
    if (infoCard) {
      infoCard.classList.replace('card--info', 'card--danger');
      infoCard.querySelector('strong').textContent = 'WebUSB not available in this browser';
      infoCard.querySelector('span').textContent =
        'Please open this page in Google Chrome or Microsoft Edge.';
    }
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function bindNavButtons() {
  document.querySelectorAll('[data-action="next"]').forEach(el =>
    el.addEventListener('click', () => goTo(currentStep + 1))
  );
  document.querySelectorAll('[data-action="prev"]').forEach(el =>
    el.addEventListener('click', () => goTo(currentStep - 1))
  );
}

function goTo(index) {
  if (index < 0 || index >= STEP_COUNT || transitioning) return;
  const direction = index > currentStep ? 'forward' : 'back';
  const prev = currentStep;
  currentStep = index;
  renderStep(prev, direction);
}

function renderStep(prevIndex, direction) {
  // Cancel in-flight timers and immediately settle any stuck leaving step
  clearTimeout(leaveTimer);
  clearTimeout(enterTimer);
  document.querySelectorAll('.step.leaving').forEach(el => {
    el.classList.remove('active', 'leaving');
    el.style.animationName = '';
  });

  const prevEl    = document.getElementById(`step-${prevIndex}`);
  const nextEl    = document.getElementById(`step-${currentStep}`);
  const goingBack = direction === 'back';
  const LEAVE_MS  = 220;

  if (prevEl && prevEl !== nextEl) {
    prevEl.classList.add('leaving');
    if (goingBack) prevEl.style.animationName = 'stepOutBack';
    leaveTimer = setTimeout(() => {
      prevEl.classList.remove('active', 'leaving');
      prevEl.style.animationName = '';
    }, LEAVE_MS);
  }

  transitioning = true;
  enterTimer = setTimeout(() => {
    nextEl.style.animationName = goingBack ? 'stepBack' : '';
    nextEl.classList.add('active');
    progressFill.style.width = `${STEP_PROGRESS[currentStep]}%`;
    if (currentStep === STEP_COUNT - 1) spawnConfetti();
    transitioning = false;
  }, prevEl && prevEl !== nextEl ? LEAVE_MS : 0);
}

// ── Action bindings ───────────────────────────────────────────────────────────
function bindActions() {
  pairBtn.addEventListener('click', handlePair);
  cantSeeBtn.addEventListener('click', toggleDriverHelp);
  exitBtn.addEventListener('click', handleExitDFU);
  restartBtn.addEventListener('click', handleRestart);
}

// ── Driver help toggle ────────────────────────────────────────────────────────
const SVG_INFO     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const SVG_CHEVRON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;

function toggleDriverHelp() {
  const open = driverHelp.classList.toggle('open');
  cantSeeBtn.innerHTML = open
    ? `${SVG_CHEVRON} Hide`
    : `${SVG_INFO} I can't see my radio in the list`;
}

// ── Pair (step 2) ────────────────────────────────────────────────────────────
async function handlePair() {
  pairBtn.disabled = true;
  pairBtn.textContent = 'Opening picker…';
  pairHint.style.display = 'none';

  try {
    dfuDevice = await DFUDevice.requestDevice();
    await dfuDevice.open();

    pairIdle.style.display      = 'none';
    pairConnected.style.display = 'flex';
    deviceNameLbl.textContent   = dfuDevice.productName;

    pairBtn.style.display     = 'none';
    pairNextBtn.style.display = 'inline-flex';

  } catch (err) {
    pairBtn.disabled    = false;
    pairBtn.textContent = 'Open device picker';

    if (err.name === 'NotFoundError') {
      // User closed the picker without selecting — nudge toward the help panel
      pairHint.style.display = 'block';
      pairHintMsg.textContent =
        'Nothing selected — if your radio wasn\'t in the list, tap "I can\'t see my radio" below.';
    } else if (err.message?.includes('WebUSB')) {
      pairHint.style.display = 'block';
      pairHintMsg.textContent = err.message;
    } else {
      pairHint.style.display = 'block';
      pairHintMsg.textContent = `Could not open device: ${err.message}`;
    }
  }
}

// ── Exit DFU (step 3) ────────────────────────────────────────────────────────
async function handleExitDFU() {
  if (!dfuDevice) {
    exitStatus.className = 'exit-status error';
    exitStatus.textContent = 'No radio paired — go back and pair the device first.';
    return;
  }

  exitBtn.disabled = true;
  exitStatus.className = 'exit-status loading';
  exitStatus.textContent = 'Sending exit command…';

  try {
    await dfuDevice.leaveDFU(msg => {
      exitStatus.textContent = msg;
    });

    await dfuDevice.close();
    dfuDevice = null;

    exitStatus.className   = 'exit-status';
    exitStatus.textContent = '';

    await new Promise(r => setTimeout(r, 400));
    goTo(4);

  } catch (err) {
    exitBtn.disabled = false;
    exitStatus.className = 'exit-status error';

    const msg = err.message?.toLowerCase() ?? '';
    if (msg.includes('disconnected') || msg.includes('device lost') || msg.includes('transfer failed')) {
      // USB disconnect during leave is expected — device jumped to application
      exitStatus.className   = 'exit-status';
      exitStatus.textContent = '';
      await new Promise(r => setTimeout(r, 400));
      goTo(4);
    } else {
      exitStatus.textContent = `Error: ${err.message}. Make sure you held the power button and try again.`;
    }
  }
}

// ── Restart ───────────────────────────────────────────────────────────────────
function handleRestart() {
  if (dfuDevice) {
    dfuDevice.close().catch(() => {});
    dfuDevice = null;
  }

  // Reset pair step
  pairIdle.style.display      = 'flex';
  pairConnected.style.display = 'none';
  pairHint.style.display      = 'none';
  pairBtn.style.display       = 'inline-flex';
  pairBtn.disabled            = false;
  pairBtn.textContent         = 'Open device picker';
  pairNextBtn.style.display   = 'none';

  // Reset driver help panel
  driverHelp.classList.remove('open');
  cantSeeBtn.innerHTML = `${SVG_INFO} I can't see my radio in the list`;

  // Reset exit step
  exitBtn.disabled        = false;
  exitStatus.className    = 'exit-status';
  exitStatus.textContent  = '';

  goTo(0);
}

// ── Confetti (success step) ───────────────────────────────────────────────────
function spawnConfetti() {
  successBurst.innerHTML = '';
  const colors = ['var(--accent)', 'var(--success)', 'var(--info)', 'oklch(75% 0.18 320)'];
  const count  = 28;

  for (let i = 0; i < count; i++) {
    const el    = document.createElement('div');
    const angle = (360 / count) * i + (Math.random() * 20 - 10);
    const dist  = 60 + Math.random() * 70;
    const size  = 5 + Math.random() * 6;
    const dur   = 600 + Math.random() * 500;
    const color = colors[i % colors.length];
    const shape = Math.random() > 0.5 ? '50%' : '2px';

    el.style.cssText = `
      position: absolute; left: 50%; top: 50%;
      width: ${size}px; height: ${size}px;
      background: ${color}; border-radius: ${shape};
      transform: translate(-50%, -50%);
      animation: burst ${dur}ms cubic-bezier(0,0,0.2,1) forwards;
      --tx: ${Math.cos((angle * Math.PI) / 180) * dist}px;
      --ty: ${Math.sin((angle * Math.PI) / 180) * dist}px;
    `;
    successBurst.appendChild(el);
  }

  if (!document.getElementById('burstKf')) {
    const style = document.createElement('style');
    style.id = 'burstKf';
    style.textContent = `
      @keyframes burst {
        0%   { transform: translate(-50%,-50%) scale(0); opacity: 1; }
        60%  { opacity: 1; }
        100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(1); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────
const themeBtn  = document.getElementById('themeBtn');
const themeIcon = document.getElementById('themeIcon');

const SUN_ICON  = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
const MOON_ICON = `<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>`;

function isDark() {
  return document.documentElement.classList.contains('theme-dark') ||
    (!document.documentElement.classList.contains('theme-light') &&
     window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(dark) {
  document.documentElement.classList.toggle('theme-dark', dark);
  document.documentElement.classList.toggle('theme-light', !dark);
  themeIcon.innerHTML = dark ? SUN_ICON : MOON_ICON;
}

function initTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // Set icon to match current state without forcing a class (media query handles initial render)
  themeIcon.innerHTML = dark ? SUN_ICON : MOON_ICON;
}

themeBtn.addEventListener('click', () => applyTheme(!isDark()));

// ── Boot ──────────────────────────────────────────────────────────────────────
initTheme();
init();
