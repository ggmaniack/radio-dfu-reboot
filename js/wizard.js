import { DFUDevice } from './dfu.js';

// ── OS detection ─────────────────────────────────────────────────────────────
function detectOS() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac'))     return 'macos';
  if (ua.includes('linux'))   return 'linux';
  return 'unknown';
}

function isWebUSBSupported() {
  return !!navigator.usb;
}

// ── Step definitions ─────────────────────────────────────────────────────────
const STEP_COUNT = 6; // steps 0–5
const STEP_PROGRESS = [0, 20, 40, 60, 80, 100];

// ── Wizard state ─────────────────────────────────────────────────────────────
let currentStep = 0;
let dfuDevice   = null;
const os = detectOS();

// ── DOM refs ─────────────────────────────────────────────────────────────────
const progressFill  = document.getElementById('progressFill');
const cardWindows   = document.getElementById('cardWindows');
const driverWin     = document.getElementById('driverWin');
const driverMac     = document.getElementById('driverMac');
const pairBtn       = document.getElementById('pairBtn');
const pairNextBtn   = document.getElementById('pairNextBtn');
const pairIdle      = document.getElementById('pairIdle');
const pairConnected = document.getElementById('pairConnected');
const pairError     = document.getElementById('pairError');
const pairErrorMsg  = document.getElementById('pairErrorMsg');
const deviceNameLbl = document.getElementById('deviceNameLabel');
const exitBtn       = document.getElementById('exitBtn');
const exitStatus    = document.getElementById('exitStatus');
const restartBtn    = document.getElementById('restartBtn');
const successBurst  = document.getElementById('successBurst');

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  applyOSVariants();
  checkBrowserSupport();
  bindNavButtons();
  bindActions();
  renderStep(0, 'none');
}

function applyOSVariants() {
  if (os === 'windows') {
    cardWindows.style.display = 'flex';
  }
  if (os !== 'windows') {
    driverWin.style.display = 'none';
    driverMac.style.display = 'block';
  }
}

function checkBrowserSupport() {
  if (!isWebUSBSupported()) {
    const infoCard = document.querySelector('.card--info');
    if (infoCard) {
      infoCard.classList.add('card--danger');
      infoCard.classList.remove('card--info');
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
  if (index < 0 || index >= STEP_COUNT) return;
  const direction = index > currentStep ? 'forward' : 'back';
  const prev = currentStep;
  currentStep = index;
  renderStep(prev, direction);
}

function renderStep(prevIndex, direction) {
  const prevEl = document.getElementById(`step-${prevIndex}`);
  const nextEl = document.getElementById(`step-${currentStep}`);
  const goingBack = direction === 'back';

  if (prevEl && prevEl !== nextEl) {
    prevEl.classList.add('leaving');
    if (goingBack) prevEl.style.animationName = 'stepOutBack';
    prevEl.addEventListener('animationend', () => {
      prevEl.classList.remove('active', 'leaving');
      prevEl.style.animationName = '';
    }, { once: true });
  }

  const LEAVE_MS = 220; // match stepOut duration
  setTimeout(() => {
    nextEl.style.animationName = goingBack ? 'stepBack' : '';
    nextEl.classList.add('active');
    progressFill.style.width = `${STEP_PROGRESS[currentStep]}%`;
    if (currentStep === STEP_COUNT - 1) spawnConfetti();
  }, prevEl && prevEl !== nextEl ? LEAVE_MS : 0);
}

// ── Action bindings ───────────────────────────────────────────────────────────
function bindActions() {
  pairBtn.addEventListener('click', handlePair);
  exitBtn.addEventListener('click', handleExitDFU);
  restartBtn.addEventListener('click', handleRestart);
}

// ── Pair (step 3) ────────────────────────────────────────────────────────────
async function handlePair() {
  pairBtn.disabled = true;
  pairBtn.textContent = 'Opening picker…';
  pairError.style.display = 'none';

  try {
    dfuDevice = await DFUDevice.requestDevice();
    await dfuDevice.open();

    pairIdle.style.display      = 'none';
    pairConnected.style.display = 'flex';
    deviceNameLbl.textContent   = dfuDevice.productName;

    pairBtn.style.display     = 'none';
    pairNextBtn.style.display = 'inline-flex';

  } catch (err) {
    pairBtn.disabled     = false;
    pairBtn.textContent  = 'Open device picker';

    pairError.style.display = 'flex';
    if (err.name === 'NotFoundError') {
      pairErrorMsg.textContent = 'No device selected. Make sure the radio is connected in DFU mode (blank screen) and try again.';
    } else if (err.message.includes('WebUSB')) {
      pairErrorMsg.textContent = err.message;
    } else {
      pairErrorMsg.textContent = `Could not open device: ${err.message}`;
    }
  }
}

// ── Exit DFU (step 4) ────────────────────────────────────────────────────────
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

    // Device disconnected — that's the success signal
    await dfuDevice.close();
    dfuDevice = null;

    exitStatus.className = 'exit-status';
    exitStatus.textContent = '';

    // Small delay so the user sees the button change before transition
    await new Promise(r => setTimeout(r, 400));
    goTo(5);

  } catch (err) {
    exitBtn.disabled = false;
    exitStatus.className = 'exit-status error';

    if (err.message?.toLowerCase().includes('disconnected') ||
        err.message?.toLowerCase().includes('device lost') ||
        err.message?.toLowerCase().includes('transfer failed')) {
      // Disconnects during the leave sequence are expected — treat as success
      exitStatus.className = 'exit-status';
      exitStatus.textContent = '';
      await new Promise(r => setTimeout(r, 400));
      goTo(5);
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

  // Reset pair step UI
  pairIdle.style.display      = 'flex';
  pairConnected.style.display = 'none';
  pairError.style.display     = 'none';
  pairBtn.style.display       = 'inline-flex';
  pairBtn.disabled            = false;
  pairBtn.textContent         = 'Open device picker';
  pairNextBtn.style.display   = 'none';

  // Reset exit step UI
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
    const el = document.createElement('div');
    const angle  = (360 / count) * i + (Math.random() * 20 - 10);
    const dist   = 60 + Math.random() * 70;
    const size   = 5 + Math.random() * 6;
    const dur    = 600 + Math.random() * 500;
    const color  = colors[i % colors.length];
    const shape  = Math.random() > 0.5 ? '50%' : '2px';

    el.style.cssText = `
      position: absolute;
      left: 50%; top: 50%;
      width: ${size}px; height: ${size}px;
      background: ${color};
      border-radius: ${shape};
      transform: translate(-50%, -50%);
      animation: burst ${dur}ms cubic-bezier(0,0,0.2,1) forwards;
      --tx: ${Math.cos((angle * Math.PI) / 180) * dist}px;
      --ty: ${Math.sin((angle * Math.PI) / 180) * dist}px;
    `;
    successBurst.appendChild(el);
  }

  // Inject keyframes once
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

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
