import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts/ui-validation");
const validationState = resolve(root, "runtime/ui-validation");
await mkdir(artifacts, { recursive: true });
await rm(validationState, { recursive: true, force: true });
await mkdir(validationState, { recursive: true });
const attachmentFixture = join(validationState, "browser attachment.txt");
const attachmentContent = "Browser attachment proof: bytes arrived separately from the prompt.\n";
await writeFile(attachmentFixture, attachmentContent);
const profile = await mkdtemp(join(tmpdir(), "openbot-hub-chrome-"));
let dev;
let chrome;
let socket;
const failures = [];

function waitOutput(child, stream, pattern, timeout = 10_000) {
  return new Promise((resolveEvent, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${text}`)), timeout);
    child[stream].on("data", (chunk) => {
      text += chunk.toString("utf8");
      const match = text.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolveEvent(match);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited ${code}: ${text}`));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Shutdown timed out")), 8_000))]);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    socket = new WebSocket(this.url);
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.method === "Runtime.exceptionThrown") failures.push(event.params.exceptionDetails.text);
      if (!event.id) return;
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      if (event.error) pending.reject(new Error(event.error.message));
      else pending.resolve(event.result);
    };
    await new Promise((resolveOpen, reject) => {
      socket.onopen = resolveOpen;
      socket.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async wait(expression) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  }
  async screenshot(name) {
    const result = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(artifacts, `${name}.png`), Buffer.from(result.data, "base64"));
  }
}

try {
  dev = spawn(process.execPath, [resolve(root, "server/server.mjs"), "--host", "127.0.0.1", "--port", "0", "--state", "runtime/ui-validation/state.json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = await waitOutput(dev, "stdout", /"type":"openbot-hub\.ready","url":"([^"]+)"/);
  const url = ready[1];

  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debugging = await waitOutput(chrome, "stderr", /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
  const targets = await (await fetch(`http://127.0.0.1:${debugging[1]}/json/list`)).json();
  const cdp = new Cdp(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url });
  await cdp.wait(`document.querySelectorAll('#agent-list .agent-row').length === 2`);
  await cdp.wait(`document.querySelector('#connection-state').textContent.includes('LIVE')`);
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = '@Mini Fake browser acceptance';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('#messages').textContent.includes('Received: @Mini Fake browser acceptance')`);
  await cdp.wait(`document.querySelector('#messages').textContent.includes('MAC-MINI')`);
  const desktop = await cdp.evaluate(`({
    width: innerWidth,
    rooms: document.querySelectorAll('#room-list .room-row').length,
    agents: document.querySelectorAll('#agent-list .agent-row').length,
    railVisible: getComputedStyle(document.querySelector('#rail')).display !== 'none',
    inspectorVisible: getComputedStyle(document.querySelector('#inspector')).display !== 'none',
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    replyVisible: document.querySelector('#messages').textContent.includes('Received: @Mini Fake browser acceptance')
  })`);
  await cdp.screenshot("desktop");

  await cdp.send("DOM.enable");
  const browserDocument = await cdp.send("DOM.getDocument", { depth: 0 });
  const fileInput = await cdp.send("DOM.querySelector", { nodeId: browserDocument.root.nodeId, selector: "#attachment-input" });
  await cdp.send("DOM.setFileInputFiles", { nodeId: fileInput.nodeId, files: [attachmentFixture] });
  await cdp.wait(`document.querySelector('.attachment-chip[data-status="ready"]')`);
  const attachmentSelection = await cdp.evaluate(`({
    roomLocked: [...document.querySelectorAll('#room-list .room-row')].every((button) => button.disabled),
    sendEnabled: !document.querySelector('#send-button').disabled,
    hashVisible: document.querySelector('.attachment-chip').textContent.includes('SHA-256')
  })`);
  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake browser attachment';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.message-attachment') && document.querySelector('#messages').textContent.includes('Received: @Mini Fake browser attachment')`);
  const attachmentBrowser = await cdp.evaluate(`(async () => {
    const link = document.querySelector('.message-attachment');
    const response = await fetch(link.href);
    return {
      metadata: link.textContent.includes('browser attachment.txt') && link.textContent.includes('SHA-256'),
      download: await response.text(),
      composerCleared: !document.querySelector('.attachment-chip') && document.querySelector('#attachment-list').hidden,
      roomUnlocked: [...document.querySelectorAll('#room-list .room-row')].every((button) => !button.disabled),
      fitsViewport: document.documentElement.scrollWidth <= innerWidth
    };
  })()`);
  const attachmentState = await (await fetch(new URL('/api/state', url))).json();
  const attachmentMessage = attachmentState.messages.find((message) => message.text === '@Mini Fake browser attachment');
  const deliveredAttachment = await readFile(join(root, 'runtime/hub/mini-workspace/received-attachments', attachmentMessage.attachments[0].id), 'utf8');
  const attachmentUi = {
    ...attachmentSelection,
    ...attachmentBrowser,
    download: attachmentBrowser.download === attachmentContent,
    byteDelivery: deliveredAttachment === attachmentContent,
  };
  await cdp.screenshot("desktop-attachment");

  const executionVisible = await cdp.evaluate(`[...document.querySelectorAll('.execution-card')].some((card) => card.dataset.status === 'completed')`);
  await cdp.evaluate(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Mini Fake')).querySelector('.agent-test').click()`);
  await cdp.wait(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Mini Fake')).textContent.includes('AVAILABLE')`);
  const connectivity = await cdp.evaluate(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Mini Fake')).textContent.includes('AVAILABLE')`);

  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake fail-once browser retry';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.execution-card[data-status="failed"] .retry-execution')`);
  const failureUi = await cdp.evaluate(`document.querySelector('.execution-card[data-status="failed"] .execution-error')?.textContent.includes('pre-execution')`);
  await cdp.evaluate(`document.querySelector('.execution-card[data-status="failed"] .retry-execution').click()`);
  await cdp.wait(`document.querySelector('#messages').textContent.includes('Received: @Mini Fake fail-once browser retry') && !document.querySelector('.retry-execution')`);
  const retryUi = await cdp.evaluate(`[...document.querySelectorAll('.execution-card')].some((card) => card.dataset.status === 'completed' && card.textContent.includes('attempt 2'))`);

  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake progress slow:5000 browser progress';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.execution-card[data-status="running"] .execution-event[data-kind="tool"][data-status="pending"]')`);
  const pendingProgress = await cdp.evaluate(`(() => {
    const tool = document.querySelector('.execution-card[data-status="running"] .execution-event[data-kind="tool"][data-status="pending"]');
    const card = tool.closest('.execution-card');
    return card.textContent.includes('mac-mini') && card.textContent.includes("printf 'progress complete") && card.querySelector('.execution-event[data-kind="plan"][data-status="in_progress"]')?.textContent.includes('Inspect the assigned workspace');
  })()`);
  await cdp.screenshot("desktop-progress-pending");
  await cdp.wait(`document.querySelector('.execution-event[data-kind="tool"][data-status="completed"]') && document.querySelector('#messages').textContent.includes('Received: @Mini Fake progress slow:5000 browser progress')`);
  const completedProgress = await cdp.evaluate(`(() => {
    const tool = document.querySelector('.execution-event[data-kind="tool"][data-status="completed"]');
    const card = tool.closest('.execution-card');
    return card.textContent.includes('mac-mini') && card.textContent.includes('"stdout": "progress complete') && card.textContent.includes('"exitCode": 0') && card.querySelector('.execution-event[data-kind="plan"][data-status="completed"]')?.textContent.includes('Return verified output to the room');
  })()`);
  await cdp.evaluate(`document.querySelector('.execution-event[data-kind="tool"][data-status="completed"]').scrollIntoView({ block: 'center' })`);
  await cdp.screenshot("desktop-progress-completed");
  const progressUi = pendingProgress && completedProgress;

  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake slow:5000 browser stop';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.execution-card[data-status="running"] .stop-execution')`);
  await cdp.screenshot("desktop-running");
  await cdp.evaluate(`document.querySelector('.execution-card[data-status="running"] .stop-execution').click()`);
  await cdp.wait(`document.querySelector('.execution-card[data-status="interrupted"]')`);
  const stoppedUi = await cdp.evaluate(`Boolean(document.querySelector('.execution-card[data-status="interrupted"]')) && !document.querySelector('#messages').textContent.includes('Received: @Mini Fake slow:5000 browser stop')`);

  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake approval browser decision';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.execution-card[data-status="waiting"] .approval-option[data-option-id="allow_once"]')`);
  await cdp.screenshot("desktop-approval");
  const approvalDetails = await cdp.evaluate(`(() => {
    const card = document.querySelector('.approval-card[data-status="pending"]');
    return card.textContent.includes("printf 'approved\\\\n' > approval-proof.txt") && card.textContent.includes('approval-proof.txt:1') && card.textContent.includes('--- old text') && card.textContent.includes('+++ new text');
  })()`);
  await cdp.evaluate(`document.querySelector('.execution-card[data-status="waiting"] .approval-option[data-option-id="allow_once"]').click()`);
  await cdp.wait(`document.querySelector('.approval-card[data-status="approved"]') && document.querySelector('#messages').textContent.includes('Received: @Mini Fake approval browser decision')`);
  const approvalUi = await cdp.evaluate(`Boolean(document.querySelector('.approval-card[data-status="approved"]')) && !document.querySelector('.execution-card[data-status="waiting"] .approval-option')`);

  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake question browser structured answer';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.approval-card[data-kind="question"][data-status="pending"] .question-submit')`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  await cdp.evaluate(`(() => {
    const card = document.querySelector('.approval-card[data-kind="question"][data-status="pending"]');
    card.querySelector('[name="pm"]').value = 'npm';
    card.querySelector('[name="pm_custom"]').value = 'pnpm';
    card.querySelector('[name="count"]').value = '3';
    card.querySelector('[name="ratio"]').value = '0.5';
    card.querySelector('[name="verbose"]').checked = true;
    for (const option of card.querySelector('[name="channels"]').options) option.selected = true;
  })()`);
  const decimalForm = await cdp.evaluate(`(() => {
    const ratio = document.querySelector('.approval-question [name="ratio"]');
    return { step: ratio.step, valid: ratio.form.reportValidity(), stepMismatch: ratio.validity.stepMismatch };
  })()`);
  await cdp.screenshot("desktop-question");
  await cdp.evaluate(`document.querySelector('.approval-question').requestSubmit()`);
  await cdp.wait(`document.querySelector('.approval-card[data-status="answered"]') && document.querySelector('#messages').textContent.includes('Question answers:')`);
  const questionUi = await cdp.evaluate(`(() => {
    const card = document.querySelector('.approval-card[data-status="answered"]');
    return card.textContent.includes('"pm": "npm"') && card.textContent.includes('"pm_custom": "pnpm"') && card.textContent.includes('"count": 3') && card.textContent.includes('"ratio": 0.5') && document.querySelector('#messages').textContent.includes('\\"pm\\":\\"npm\\"');
  })()`);
  const decimalSubmission = decimalForm.step === 'any' && decimalForm.valid && !decimalForm.stepMismatch && questionUi;

  const supervision = { executionVisible, connectivity, failureUi, retryUi, progressUi, stoppedUi, approvalUi, approvalDetails, questionUi, decimalSubmission };

  await cdp.evaluate(`document.querySelector('#add-agent-button').click()`);
  await cdp.wait(`document.querySelector('#agent-dialog').open`);
  await cdp.evaluate(`(() => {
    document.querySelector('#agent-name-input').value = 'Browser Helper';
    document.querySelector('#agent-node-input').value = 'mac-mini';
    document.querySelector('#agent-transport').value = 'local-opencode';
    document.querySelector('#agent-transport').dispatchEvent(new Event('change'));
  })()`);
  const opencodeFields = await cdp.evaluate(`!document.querySelector('#opencode-agent-fields').hidden && document.querySelector('#agent-command').required && document.querySelector('#agent-central-workspace').required && document.querySelector('#central-workspace-label').textContent === 'OpenCode workspace'`);
  if (!opencodeFields) throw new Error("OpenCode agent form acceptance failed");
  await cdp.evaluate(`(() => {
    document.querySelector('#agent-transport').value = 'local-fake';
    document.querySelector('#agent-transport').dispatchEvent(new Event('change'));
    document.querySelector('#agent-central-workspace').value = 'runtime/hub/browser-helper-central';
  })()`);
  await cdp.screenshot("agent-dialog");
  await cdp.evaluate(`document.querySelector('#agent-form').requestSubmit()`);
  await cdp.wait(`document.querySelectorAll('#agent-list .agent-row').length === 3 && !document.querySelector('#agent-dialog').open`);
  const registered = await cdp.evaluate(`document.querySelector('#agent-list').textContent.includes('Browser Helper')`);

  await cdp.evaluate(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Browser Helper')).querySelector('.agent-edit').click()`);
  await cdp.wait(`document.querySelector('#agent-dialog').open`);
  await cdp.evaluate(`(() => {
    document.querySelector('#agent-name-input').value = 'Browser Helper Pro';
    document.querySelector('#agent-enabled').checked = false;
    document.querySelector('#agent-form').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('#agent-list').textContent.includes('DISABLED')`);
  const disabled = await cdp.evaluate(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Browser Helper Pro')).querySelector('.agent-address').disabled`);

  await cdp.evaluate(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Browser Helper Pro')).querySelector('.agent-edit').click()`);
  await cdp.evaluate(`(() => {
    document.querySelector('#agent-enabled').checked = true;
    document.querySelector('#agent-form').requestSubmit();
  })()`);
  await cdp.wait(`!document.querySelector('#agent-list').textContent.includes('DISABLED') && !document.querySelector('#agent-dialog').open`);
  await cdp.evaluate(`[...document.querySelectorAll('.agent-row')].find((row) => row.textContent.includes('Browser Helper Pro')).querySelector('.agent-edit').click()`);
  await cdp.evaluate(`window.confirm = () => true; document.querySelector('#remove-agent-button').click()`);
  await cdp.wait(`document.querySelectorAll('#agent-list .agent-row').length === 2 && !document.querySelector('#agent-dialog').open`);
  const removed = await cdp.evaluate(`!document.querySelector('#agent-list').textContent.includes('Browser Helper')`);

  await cdp.evaluate(`document.querySelector('#add-room-button').click()`);
  await cdp.wait(`document.querySelector('#room-dialog').open`);
  await cdp.evaluate(`(() => {
    document.querySelector('#room-name-input').value = 'Browser Ops';
    document.querySelector('#room-purpose-input').value = 'Mini-only browser acceptance';
    for (const checkbox of document.querySelectorAll('#room-member-options input')) checkbox.checked = checkbox.value === 'mini-fake';
    document.querySelector('#room-form').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('#room-name').textContent === 'Browser Ops' && !document.querySelector('#room-dialog').open`);
  const roomScoped = await cdp.evaluate(`({
    rooms: document.querySelectorAll('#room-list .room-row').length,
    mini: document.querySelector('#mention-row').textContent.includes('@Mini Fake'),
    dellExcluded: !document.querySelector('#mention-row').textContent.includes('@Dell Fake')
  })`);
  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@everyone room browser acceptance';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('#messages').textContent.includes('Received: @everyone room browser acceptance')`);
  const roomReply = await cdp.evaluate(`document.querySelector('#messages').textContent.includes('MAC-MINI') && !document.querySelector('#messages').textContent.includes('DEMO-DELL')`);
  await cdp.screenshot("desktop-room");

  await cdp.evaluate(`document.querySelector('#edit-room-button').click()`);
  await cdp.wait(`document.querySelector('#room-dialog').open`);
  await cdp.evaluate(`(() => {
    document.querySelector('#room-name-input').value = 'Browser Ops Pro';
    document.querySelector('#room-purpose-input').value = 'Edited room lifecycle acceptance';
    for (const checkbox of document.querySelectorAll('#room-member-options input')) checkbox.checked = true;
    document.querySelector('#room-form').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('#room-name').textContent === 'Browser Ops Pro' && !document.querySelector('#room-dialog').open`);
  await cdp.evaluate(`document.querySelector('#edit-room-button').click()`);
  await cdp.wait(`document.querySelector('#room-dialog').open`);
  const roomEdited = await cdp.evaluate(`document.querySelector('#room-name').textContent === 'Browser Ops Pro' && document.querySelector('#room-purpose-input').value === 'Edited room lifecycle acceptance' && document.querySelector('#mention-row').textContent.includes('@Dell Fake')`);
  await cdp.evaluate(`document.querySelector('#delete-room-button').click()`);
  await cdp.wait(`document.querySelector('#room-name').textContent === 'Army' && document.querySelectorAll('#room-list .room-row').length === 1 && !document.querySelector('#room-dialog').open`);
  const roomDeleted = await cdp.evaluate(`document.querySelectorAll('#room-list .room-row').length === 1 && document.querySelector('#room-name').textContent === 'Army'`);
  await cdp.evaluate(`document.querySelector('#edit-room-button').click()`);
  await cdp.wait(`document.querySelector('#room-dialog').open`);
  const armyProtected = await cdp.evaluate(`document.querySelector('#room-name-input').disabled && document.querySelector('#delete-room-button').hidden && [...document.querySelectorAll('#room-member-options input')].every((input) => input.disabled)`);
  const roomLifecycle = { roomEdited, roomDeleted, armyProtected };
  await cdp.evaluate(`document.querySelector('[data-dialog-close="room-dialog"]').click()`);

  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake approval mobile decision';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.execution-card[data-status="waiting"] .approval-option[data-option-id="reject_once"]')`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.wait(`innerWidth === 390`);
  await cdp.evaluate(`document.querySelector('#rooms-button').click()`);
  await cdp.wait(`document.querySelector('#rail').classList.contains('open')`);
  await cdp.screenshot("mobile-rooms");
  await cdp.evaluate(`[...document.querySelectorAll('#room-list .room-row')].find((row) => row.textContent.includes('Army')).click()`);
  await cdp.wait(`document.querySelector('#room-name').textContent === 'Army' && !document.querySelector('#rail').classList.contains('open')`);
  await cdp.evaluate(`document.querySelector('#agents-button').click()`);
  await cdp.wait(`document.querySelector('#inspector').classList.contains('open')`);
  const drawer = await cdp.evaluate(`({
    inspectorOpen: document.querySelector('#inspector').classList.contains('open'),
    backdropVisible: !document.querySelector('#backdrop').hidden,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  })`);
  await cdp.screenshot("mobile-agents");
  await cdp.evaluate(`document.querySelector('[data-close="inspector"]').click()`);
  await cdp.screenshot("mobile-approval");
  await cdp.evaluate(`document.querySelector('.execution-card[data-status="waiting"] .approval-option[data-option-id="reject_once"]').click()`);
  await cdp.wait(`document.querySelector('.approval-card[data-status="rejected"]') && document.querySelector('#messages').textContent.includes('The proposed step was rejected')`);
  const mobileApproval = await cdp.evaluate(`Boolean(document.querySelector('.approval-card[data-status="rejected"]')) && !document.querySelector('.execution-card[data-status="waiting"]') && document.documentElement.scrollWidth <= innerWidth`);
  await cdp.evaluate(`(() => {
    document.querySelector('#message-input').value = '@Mini Fake question mobile structured response';
    document.querySelector('#composer').requestSubmit();
  })()`);
  await cdp.wait(`document.querySelector('.approval-card[data-kind="question"][data-status="pending"] .question-decline')`);
  await cdp.screenshot("mobile-question");
  const mobileQuestionFits = await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth && Boolean(document.querySelector('.approval-question [name="pm"]'))`);
  await cdp.evaluate(`document.querySelector('.approval-card[data-kind="question"][data-status="pending"] .question-decline').click()`);
  await cdp.wait(`document.querySelector('.approval-card[data-status="declined"]') && document.querySelector('#messages').textContent.includes('The question was decline')`);
  const mobileQuestion = await cdp.evaluate(`Boolean(document.querySelector('.approval-card[data-status="declined"]')) && document.documentElement.scrollWidth <= innerWidth`) && mobileQuestionFits;
  await cdp.evaluate(`document.querySelector('.execution-event[data-kind="tool"][data-status="completed"]').scrollIntoView({ block: 'center' })`);
  const mobileProgress = await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.execution-event[data-kind="tool"][data-status="completed"]').closest('.execution-card').textContent.includes('"stdout": "progress complete')`);
  await cdp.screenshot("mobile-progress");
  await cdp.evaluate(`document.querySelector('.message-attachment').scrollIntoView({ block: 'center' })`);
  const mobileAttachment = await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.message-attachment').textContent.includes('browser attachment.txt')`);
  await cdp.screenshot("mobile-attachment");
  await cdp.evaluate(`[...document.querySelectorAll('.mention-chip')].find((button) => button.textContent === '@Dell Fake').click()`);
  const mobile = await cdp.evaluate(`({
    width: innerWidth,
    railHidden: getComputedStyle(document.querySelector('#rail')).display === 'none',
    inspectorClosed: !document.querySelector('#inspector').classList.contains('open'),
    armySelected: document.querySelector('#room-name').textContent === 'Army',
    addressed: document.querySelector('#message-input').value.startsWith('@Dell Fake'),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  })`);
  await cdp.evaluate(`document.querySelector('#message-input').value = ''`);
  await cdp.screenshot("mobile");
  await cdp.evaluate(`document.querySelector('#agents-button').click(); document.querySelector('#add-agent-button').click()`);
  await cdp.wait(`document.querySelector('#agent-dialog').open`);
  const mobileForm = await cdp.evaluate(`({
    fitsViewport: document.querySelector('#agent-dialog').getBoundingClientRect().width <= innerWidth,
    singleColumn: getComputedStyle(document.querySelector('#agent-form .form-grid')).gridTemplateColumns.split(' ').length === 1,
    localFieldsVisible: !document.querySelector('#local-agent-fields').hidden
  })`);
  await cdp.screenshot("mobile-agent-dialog");
  await cdp.evaluate(`document.querySelector('[data-dialog-close="agent-dialog"]').click(); document.querySelector('[data-close="inspector"]').click()`);
  const report = { url, desktop, attachmentUi, supervision, registered, disabled, removed, roomScoped, roomReply, roomLifecycle, drawer, mobile, mobileApproval, mobileQuestion, mobileProgress, mobileAttachment, mobileForm, runtimeExceptions: failures };
  await writeFile(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (desktop.rooms !== 1 || desktop.agents !== 2 || !desktop.railVisible || !desktop.inspectorVisible || desktop.horizontalOverflow || !desktop.replyVisible) throw new Error("Desktop acceptance failed");
  if (!Object.values(attachmentUi).every(Boolean)) throw new Error("Browser attachment acceptance failed");
  if (!Object.values(supervision).every(Boolean)) throw new Error("Browser supervision acceptance failed");
  if (!registered || !disabled || !removed) throw new Error("Agent management acceptance failed");
  if (roomScoped.rooms !== 2 || !roomScoped.mini || !roomScoped.dellExcluded || !roomReply || !Object.values(roomLifecycle).every(Boolean)) throw new Error("Room management acceptance failed");
  if (!drawer.inspectorOpen || !drawer.backdropVisible || drawer.horizontalOverflow) throw new Error("Mobile drawer acceptance failed");
  if (!mobile.railHidden || !mobile.inspectorClosed || !mobile.armySelected || !mobile.addressed || mobile.horizontalOverflow) throw new Error("Mobile acceptance failed");
  if (!mobileApproval || !mobileQuestion || !mobileProgress || !mobileAttachment) throw new Error("Mobile interaction acceptance failed");
  if (!mobileForm.fitsViewport || !mobileForm.singleColumn || !mobileForm.localFieldsVisible) throw new Error("Mobile form acceptance failed");
  if (failures.length) throw new Error("Browser runtime exceptions occurred");
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  await stop(chrome).catch((error) => console.error(error.message));
  await stop(dev).catch((error) => console.error(error.message));
  await rm(profile, { recursive: true, force: true });
}
