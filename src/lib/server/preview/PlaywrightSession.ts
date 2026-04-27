/**
 * Per-agent server-rendered browser session.
 *
 * Drives a real Chromium via Playwright on the MAW host, navigates to the
 * agent's `target_url`, and streams JPEG frames over WebSocket to the
 * dashboard via CDP `Page.startScreencast`. The session emits `frame`
 * events the WS hub forwards as `SC_StreamFrame` messages; user input
 * (pointer, keyboard, viewport changes) flows back the other way and is
 * dispatched into Playwright's input APIs.
 *
 * One session per agent. Browser context isolation means each agent has
 * its own cookies / localStorage — opening two preview agents against the
 * same dev server doesn't share auth.
 *
 * Note on Chromium binaries: the runtime uses `playwright`'s bundled
 * launcher, which expects `pnpm exec playwright install chromium` to have
 * been run once on the host. If chromium isn't available, `start()` rejects
 * with a friendly error the spawn route surfaces to the UI.
 */

import { EventEmitter } from 'node:events';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';

export interface StreamFrame {
  /** CDP-assigned monotonic frame id. The client must echo this back via
   *  `stream_frame_ack` to receive the next frame. */
  sessionId: number;
  /** JPEG bytes, base64-encoded so the WS envelope stays JSON. */
  b64: string;
  /** CSS-pixel dimensions of the rendered frame. */
  width: number;
  height: number;
}

export interface PlaywrightSessionOptions {
  agentId: string;
  targetUrl: string;
  /** Initial viewport size — typically the BrowserView's mobile preset.
   *  Updated dynamically when the user resizes the StreamView. */
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  /** JPEG quality 1..100. Higher = bigger frames, sharper image. */
  jpegQuality?: number;
  /** Cap the longest dimension of streamed frames to this many pixels.
   *  Prevents 4K Retina viewports from blasting MB-per-frame at the WS. */
  maxFrameWidth?: number;
  maxFrameHeight?: number;
}

export class PlaywrightSession extends EventEmitter {
  readonly agentId: string;
  private readonly opts: PlaywrightSessionOptions;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private cdp?: CDPSession;
  private currentUrl = '';
  private stopped = false;
  /**
   * Last frame CDP emitted, so a new WS subscriber gets an immediate paint
   * even if Chromium hasn't fired a fresh `Page.screencastFrame` since they
   * connected. (CDP only emits when the page visibly changes — a static
   * landing page rendered before any subscriber attached would otherwise
   * leave the StreamView stuck on the placeholder.)
   */
  private latestFrame: StreamFrame | null = null;

  constructor(opts: PlaywrightSessionOptions) {
    super();
    this.agentId = opts.agentId;
    this.opts = {
      jpegQuality: 70,
      maxFrameWidth: 1280,
      maxFrameHeight: 1280,
      ...opts
    };
  }

  /** Launch the browser, navigate to the target URL, and start streaming. */
  async start(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: true,
        // No need for --no-sandbox in single-user MVP, but it keeps the
        // launch deterministic across distros where the chromium sandbox
        // sometimes refuses to start under tmpfs / fuse.
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
    } catch (err) {
      // Most common failure: Chromium binary isn't installed yet.
      const msg = (err as Error).message;
      if (/Executable doesn't exist/i.test(msg) || /BROWSERS_PATH/i.test(msg)) {
        throw new Error(
          'Chromium not installed. Run `pnpm exec playwright install chromium` on the MAW host, then retry.'
        );
      }
      throw err;
    }

    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      deviceScaleFactor: this.opts.viewport.deviceScaleFactor ?? 1,
      // Treat every preview session as "mobile" by default — pointer:coarse
      // matches the most common BrowserView preset and produces the layout
      // mobile-testing users expect. The user can toggle via the StreamView
      // toolbar (TODO Phase 2).
      hasTouch: true,
      isMobile: false
    });
    this.page = await this.context.newPage();

    // Surface page-level errors as session events so the WS layer can
    // forward them to the client (avoids a silent black frame).
    this.page.on('pageerror', (err) => this.emit('error', err.message));

    // Navigate first — if the URL is unreachable we still want screencast
    // running so the user sees Chromium's net-error page instead of a
    // blank panel. Wait for `domcontentloaded` (not `commit`) so the page
    // has actually painted before we start screencasting; CDP only emits
    // `Page.screencastFrame` events when the visible surface changes, and
    // a fresh-pre-paint blank canvas wouldn't trigger one.
    try {
      await this.page.goto(this.opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      this.currentUrl = this.page.url();
    } catch (err) {
      const msg = (err as Error).message;
      // eslint-disable-next-line no-console
      console.warn(`[playwright-session ${this.agentId}] initial nav failed: ${msg}`);
    }

    // Track URL so the client can show the address bar accurately. Page
    // navigations (history.pushState, link clicks, redirects) all fire
    // `framenavigated` for the main frame.
    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page!.mainFrame()) return;
      const url = frame.url();
      if (url === this.currentUrl) return;
      this.currentUrl = url;
      this.emit('url', url);
    });

    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send('Page.enable');
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.opts.jpegQuality,
      maxWidth: this.opts.maxFrameWidth,
      maxHeight: this.opts.maxFrameHeight,
      everyNthFrame: 1
    });

    // Force the page to render at least once so CDP emits the initial
    // frame. With a fully-static page (no animations, no JS-driven layout)
    // chromium can hold off until "something changes" and the screencast
    // sits silent. A no-op scrollTo guarantees a layout/paint cycle without
    // visibly affecting the page.
    try {
      await this.page.evaluate(() => window.scrollTo(0, 0));
    } catch {
      /* navigated away; the screencast will pick up the new page */
    }

    // CDP streams base64 JPEG frames as `Page.screencastFrame` events.
    // Each frame's `sessionId` MUST be echoed back via `screencastFrameAck`
    // before CDP queues the next one.
    this.cdp.on('Page.screencastFrame', (params) => {
      if (this.stopped) return;
      const frame: StreamFrame = {
        sessionId: params.sessionId,
        b64: params.data,
        width: params.metadata.deviceWidth,
        height: params.metadata.deviceHeight
      };
      this.latestFrame = frame;
      this.emit('frame', frame);
    });

    // Don't return until CDP has actually emitted (and ack'd) the first
    // frame. Without this, the spawn route resolves while `latestFrame` is
    // still null — and the first WS subscriber arrives in that gap, getting
    // a `stream_ready` but no cached frame, leaving the StreamView stuck
    // on its placeholder until the user happens to navigate. Capped so a
    // never-rendering target (firewall, port off) doesn't deadlock spawn.
    await new Promise<void>((resolve) => {
      if (this.latestFrame) return resolve();
      const onFirst = (): void => {
        this.off('frame', onFirst);
        resolve();
      };
      this.on('frame', onFirst);
      setTimeout(() => {
        this.off('frame', onFirst);
        resolve();
      }, 4000);
    });

    this.emit('ready', this.currentUrl);
  }

  /** Echo a frame ack back to CDP so the next frame may be queued. The
   *  client sends one of these for every frame it has finished rendering. */
  async ackFrame(sessionId: number): Promise<void> {
    if (this.stopped || !this.cdp) return;
    try {
      await this.cdp.send('Page.screencastFrameAck', { sessionId });
    } catch (err) {
      // CDP target gone (browser closed) — propagate as an error event
      // and let the supervisor reap the session.
      this.emit('error', (err as Error).message);
    }
  }

  /** Forward a pointer event from the StreamView. */
  async dispatchPointer(
    kind: 'move' | 'down' | 'up',
    x: number,
    y: number,
    button: number,
    buttons: number
  ): Promise<void> {
    if (this.stopped || !this.page) return;
    try {
      const playwrightButton: 'left' | 'middle' | 'right' =
        button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
      if (kind === 'move') {
        await this.page.mouse.move(x, y);
      } else if (kind === 'down') {
        await this.page.mouse.move(x, y);
        await this.page.mouse.down({ button: playwrightButton });
      } else {
        await this.page.mouse.move(x, y);
        await this.page.mouse.up({ button: playwrightButton });
      }
    } catch (err) {
      this.emit('error', (err as Error).message);
    }
  }

  async dispatchWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    if (this.stopped || !this.page) return;
    try {
      await this.page.mouse.move(x, y);
      await this.page.mouse.wheel(deltaX, deltaY);
    } catch (err) {
      this.emit('error', (err as Error).message);
    }
  }

  async dispatchKey(
    kind: 'down' | 'up',
    key: string,
    _code: string,
    _modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
  ): Promise<void> {
    if (this.stopped || !this.page) return;
    try {
      // Playwright's `page.keyboard.down/up` accept a key name. We pass the
      // browser's `KeyboardEvent.key` value, which Playwright maps to the
      // right CDP modifier set (so Shift+a → 'A' just works).
      if (kind === 'down') await this.page.keyboard.down(key);
      else await this.page.keyboard.up(key);
    } catch (err) {
      this.emit('error', (err as Error).message);
    }
  }

  async dispatchText(text: string): Promise<void> {
    if (this.stopped || !this.page) return;
    try {
      await this.page.keyboard.insertText(text);
    } catch (err) {
      this.emit('error', (err as Error).message);
    }
  }

  /** Adjust the server-side viewport. Restarts screencast so the new
   *  viewport's frames begin streaming immediately. */
  async setViewport(width: number, height: number, deviceScaleFactor = 1): Promise<void> {
    if (this.stopped || !this.page || !this.cdp) return;
    try {
      await this.page.setViewportSize({ width, height });
      // No need to stop+restart screencast — CDP picks up the new size
      // on the next frame automatically.
      void deviceScaleFactor; // reserved for future high-DPI mode
    } catch (err) {
      this.emit('error', (err as Error).message);
    }
  }

  async navigate(url: string): Promise<void> {
    if (this.stopped || !this.page) return;
    try {
      await this.page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    } catch (err) {
      this.emit('error', (err as Error).message);
    }
  }

  async historyAction(action: 'reload' | 'back' | 'forward'): Promise<void> {
    if (this.stopped || !this.page) return;
    try {
      if (action === 'reload') await this.page.reload({ waitUntil: 'commit' });
      else if (action === 'back') await this.page.goBack({ waitUntil: 'commit' });
      else await this.page.goForward({ waitUntil: 'commit' });
    } catch (err) {
      // navigation failed (no history, page closed, …) — surface but don't
      // tear down the session. The user can hit reload again.
      this.emit('error', (err as Error).message);
    }
  }

  /** Tear down everything. Idempotent so the kill path can call it freely. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.cdp) await this.cdp.send('Page.stopScreencast').catch(() => {});
      if (this.cdp) await this.cdp.detach().catch(() => {});
    } catch { /* ignore */ }
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch { /* ignore */ }
    this.removeAllListeners();
  }

  /** Last known URL — exposed so the WS hub can include it in `stream_ready`
   *  even when the framenavigated event fires before any subscriber attached. */
  get url(): string {
    return this.currentUrl;
  }

  /** Last CDP-emitted frame, or null if no frame has arrived yet. The WS
   *  hub replays this to a new subscriber so the StreamView paints
   *  immediately instead of waiting for the next page-visible change. */
  get lastFrame(): StreamFrame | null {
    return this.latestFrame;
  }
}
