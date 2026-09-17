/**
 * Whether the window may be recorded by screenshots and screen sharing.
 *
 * Blocked by default. The app holds transcripts of meetings you have already
 * had, so if it is open while you share your screen in a later call, everything
 * on it goes to everyone in that room. For an app whose whole claim is that
 * nothing leaves the machine, broadcasting the transcripts is a poor showing.
 *
 * But blocking it outright also prevents showing your own notes to a colleague,
 * and makes the app impossible to screenshot or demonstrate. So it is a toggle
 * rather than a law, and it deliberately does not persist: allowing capture is
 * a decision for right now, and quitting the app forgets it. Nobody turns this
 * on once in 2026 and unknowingly shares a transcript in 2027.
 *
 * Kept free of Electron imports so the rules are testable without a window.
 */

/** The part of a BrowserWindow this needs. Narrow, so tests can stand in. */
export interface CaptureTarget {
  setContentProtection(enabled: boolean): void;
  isDestroyed(): boolean;
}

export class ScreenCaptureGate {
  private allowed = false;
  private readonly targets = new Set<CaptureTarget>();

  /** True when screenshots and screen sharing can see the window. */
  get isAllowed(): boolean {
    return this.allowed;
  }

  /** What the menu item should say to describe what clicking it will do. */
  get menuLabel(): string {
    return "Allow Screen Capture";
  }

  /**
   * Put a window under this gate. It adopts the current setting immediately,
   * which matters on macOS: closing the window and reopening it from the dock
   * builds a new one, and without this that new window would silently revert
   * to blocked while the menu still showed capture as allowed.
   */
  register(target: CaptureTarget): void {
    this.targets.add(target);
    this.applyTo(target);
  }

  forget(target: CaptureTarget): void {
    this.targets.delete(target);
  }

  setAllowed(next: boolean): void {
    this.allowed = next;
    this.apply();
  }

  /** @returns the new state. */
  toggle(): boolean {
    this.setAllowed(!this.allowed);
    return this.allowed;
  }

  private apply(): void {
    for (const target of [...this.targets]) {
      if (target.isDestroyed()) {
        this.targets.delete(target);
        continue;
      }
      this.applyTo(target);
    }
  }

  private applyTo(target: CaptureTarget): void {
    // Protection ON is capture OFF. Inverted, and easy to get backwards.
    target.setContentProtection(!this.allowed);
  }
}
