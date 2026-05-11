# wayfern

Playwright wrapper that transparently humanizes mouse, typing, and scroll, plus thin wrappers around the Wayfern fingerprint CDP commands.

## Install

```bash
npm install wayfern playwright
```

## Use

Drop-in: replace your `playwright` import and every page is auto-humanized.

```js
import { chromium } from "wayfern";

const browser = await chromium.launch();
const page = await browser.newPage();

await page.click("button");
await page.locator("input").hover();
await page.keyboard.type("hello world");
await page.mouse.wheel(0, 800);
```

Pass `{ steps }`, `{ trial: true }`, `{ force: true }`, or an explicit `delay` to bypass humanization for a single call.

## Attach to an existing page

For explicit control (typing speed, scrolling targets, fingerprint commands):

```js
import { chromium } from "playwright";
import { wayfern } from "wayfern";

const page = await (await chromium.launch()).newPage();
const wfp = wayfern(page);

await page.click("button");                   // still humanized via hooks
await wfp.typeText("hello", { wpm: 90 });
await wfp.scrollTo("footer");
await wfp.refreshFingerprint({ operatingSystem: "macos" });
const fp = await wfp.getFingerprint();
```

## API

```js
wfp.move(x, y, opts)              // opts: duration, overshoot (0–1)
wfp.hover(target, opts)
wfp.click(target, opts)           // opts: button, clickCount, delay, position, hoverPause
wfp.dblclick(target, opts)
wfp.clickAt(x, y, opts)
wfp.type(target, text, opts)      // opts: wpm, layout ('qwerty'|'azerty'), errors, clear, focus
wfp.typeText(text, opts)
wfp.fillForm(values, opts)        // {selector: value} or [[sel, val], …] — tabs between fields
wfp.scroll(dx, dy, opts)
wfp.scrollBy(dy, opts)
wfp.scrollTo(target, opts)
wfp.idle(ms, opts)                // micro-jitter the cursor for ms — no perfectly still cursors
wfp.pause(min, max)               // plain sleep
wfp.refreshFingerprint(params)
wfp.getFingerprint()
wfp.cdp.send(method, params)      // generic CDP escape hatch
```

Clicks insert a small "hover-before-click" pause when the cursor traveled meaningful distance to the target, mimicking visual confirmation before pressing. Disable per-call with `{ hoverPause: false }`.

To disable hook installation entirely: `wayfern(page, { hooks: false })`.

## License

MIT
