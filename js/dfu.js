/**
 * DFU protocol implementation for STM32 DfuSe bootloader.
 * Implements the "leave DFU" sequence to jump to the application at 0x08000000.
 */

const DFU = {
  REQUEST: {
    DETACH:    0x00,
    DNLOAD:    0x01,
    UPLOAD:    0x02,
    GETSTATUS: 0x03,
    CLRSTATUS: 0x04,
    GETSTATE:  0x05,
    ABORT:     0x06,
  },
  STATE: {
    appIDLE:              0,
    appDETACH:            1,
    dfuIDLE:              2,
    dfuDNLOAD_SYNC:       3,
    dfuDNBUSY:            4,
    dfuDNLOAD_IDLE:       5,
    dfuMANIFEST_SYNC:     6,
    dfuMANIFEST:          7,
    dfuMANIFEST_WAIT_RST: 8,
    dfuUPLOAD_IDLE:       9,
    dfuERROR:             10,
  },
  STATUS: { OK: 0 },
  // DfuSe special command codes (wBlockNum=0 mode)
  CMD: {
    SET_ADDRESS: 0x21,
  },
};

// STM32 internal bootloader — standard VID/PID
const DEVICE_FILTERS = [
  { vendorId: 0x0483, productId: 0xDF11 },
];

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export class DFUDevice {
  #device;
  #ifaceNum = 0;

  constructor(usbDevice) {
    this.#device = usbDevice;
  }

  get productName() {
    return this.#device.productName || 'STM32 BOOTLOADER';
  }

  static async requestDevice() {
    if (!navigator.usb) {
      throw new Error(
        'WebUSB is not available. Please use Chrome or Edge (not Firefox or Safari).'
      );
    }
    const device = await navigator.usb.requestDevice({ filters: DEVICE_FILTERS });
    return new DFUDevice(device);
  }

  // Find the DFU interface by USB class 0xFE / subclass 0x01
  #findDFUInterface() {
    for (const config of this.#device.configurations) {
      for (const iface of config.interfaces) {
        for (const alt of iface.alternates) {
          if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
            return { configValue: config.configurationValue, ifaceNum: iface.interfaceNumber };
          }
        }
      }
    }
    return null;
  }

  async open() {
    await this.#device.open();

    const found = this.#findDFUInterface();
    if (found) {
      this.#ifaceNum = found.ifaceNum;
      const currentConfig = this.#device.configuration?.configurationValue;
      if (currentConfig !== found.configValue) {
        await this.#device.selectConfiguration(found.configValue);
      }
    } else if (this.#device.configuration === null) {
      await this.#device.selectConfiguration(1);
    }

    await this.#device.claimInterface(this.#ifaceNum);
  }

  async close() {
    try { await this.#device.releaseInterface(this.#ifaceNum); } catch {}
    try { await this.#device.close(); } catch {}
  }

  async #out(request, value, data = new Uint8Array(0)) {
    const result = await this.#device.controlTransferOut(
      { requestType: 'class', recipient: 'interface', request, value, index: this.#ifaceNum },
      data
    );
    if (result.status !== 'ok') throw new Error(`USB transfer failed: ${result.status}`);
  }

  async #in(request, value, length) {
    const result = await this.#device.controlTransferIn(
      { requestType: 'class', recipient: 'interface', request, value, index: this.#ifaceNum },
      length
    );
    if (result.status !== 'ok') throw new Error(`USB transfer failed: ${result.status}`);
    return result.data;
  }

  async getStatus() {
    const data = await this.#in(DFU.REQUEST.GETSTATUS, 0, 6);
    if (data.byteLength < 6) throw new Error('Short DFU status response');
    return {
      bStatus:      data.getUint8(0),
      pollTimeout:  data.getUint8(1) | (data.getUint8(2) << 8) | (data.getUint8(3) << 16),
      bState:       data.getUint8(4),
      iString:      data.getUint8(5),
    };
  }

  // Poll GETSTATUS until we leave dfuDNBUSY
  async #waitNotBusy() {
    let st;
    for (let i = 0; i < 30; i++) {
      st = await this.getStatus();
      if (st.bState !== DFU.STATE.dfuDNBUSY) return st;
      await delay(Math.max(st.pollTimeout, 10));
    }
    throw new Error('Device stuck in dfuDNBUSY');
  }

  async #prepare() {
    let st = await this.getStatus();

    if (st.bState === DFU.STATE.dfuERROR) {
      await this.#out(DFU.REQUEST.CLRSTATUS, 0);
      st = await this.getStatus();
    }

    if ([DFU.STATE.dfuDNLOAD_SYNC, DFU.STATE.dfuDNLOAD_IDLE, DFU.STATE.dfuUPLOAD_IDLE].includes(st.bState)) {
      await this.#out(DFU.REQUEST.ABORT, 0);
      st = await this.getStatus();
    }

    if (st.bState !== DFU.STATE.dfuIDLE) {
      throw new Error(`Unexpected DFU state: ${st.bState}. Try unplugging and reconnecting the radio.`);
    }
  }

  /**
   * Send the DfuSe "leave DFU" sequence:
   *   1. Set Address Pointer → 0x08000000
   *   2. Zero-length DNLOAD → triggers manifestation
   *   3. GETSTATUS → device executes jump and disconnects (USB error expected)
   */
  async leaveDFU(onProgress) {
    onProgress?.('Checking device state…');
    await this.#prepare();

    onProgress?.('Setting jump address…');
    const setAddrCmd = new Uint8Array([
      DFU.CMD.SET_ADDRESS,
      0x00, 0x00, 0x00, 0x08,  // 0x08000000 little-endian
    ]);
    await this.#out(DFU.REQUEST.DNLOAD, 0, setAddrCmd);

    await this.#waitNotBusy();

    onProgress?.('Sending leave command…');
    // Zero-length DNLOAD with wBlockNum=0 triggers the DfuSe leave
    await this.#out(DFU.REQUEST.DNLOAD, 0, new Uint8Array(0));

    onProgress?.('Jumping to application…');
    // GETSTATUS executes the jump — device will disconnect, so we expect an error
    try {
      await this.getStatus();
    } catch {
      // USB disconnect after the jump is the expected success case
    }

    onProgress?.('Done');
  }
}
