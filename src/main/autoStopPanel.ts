import { BrowserWindow, screen, type WebContents } from "electron";

import type { ScreenCaptureGate } from "./screenCapture.ts";

const WIDTH = 380;
const HEIGHT = 128;
const MARGIN = 16;

/**
 * The small floating window that shows an auto-stop countdown.
 *
 * Its own window because the main one is rarely in view when it matters: during
 * a call it sits behind Zoom or a browser, and after one it has often been
 * closed. Shown without taking focus, so it never steals keystrokes from the
 * call, and kept under the screen-capture gate like every other window, so it
 * stays out of screen shares (FR-30).
 *
 * It renders nothing of its own. It loads the same UI as the main window in
 * its panel view, which asks for the countdown and follows it from there.
 */
export interface AutoStopPanelOptions {
  preload: string;
  load: (window: BrowserWindow) => void;
  capture: ScreenCaptureGate;
}

export class AutoStopPanel {
  private readonly options: AutoStopPanelOptions;
  private window: BrowserWindow | null = null;

  constructor(options: AutoStopPanelOptions) {
    this.options = options;
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      return;
    }

    const { workArea } = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: Math.round(workArea.x + workArea.width - WIDTH - MARGIN),
      y: Math.round(workArea.y + MARGIN),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#171b21",
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    window.setAlwaysOnTop(true, "floating");
    this.options.capture.register(window);

    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.showInactive();
    });
    window.on("closed", () => {
      this.options.capture.forget(window);
      if (this.window === window) this.window = null;
    });

    this.window = window;
    this.options.load(window);
  }

  hide(): void {
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  /** Its contents, for pushing the countdown to it. Null while hidden. */
  get webContents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }
}
