import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

class ClassList {
  constructor(initial = "") {
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
  }
}

class MockElement {
  constructor(id = "", className = "") {
    this.id = id;
    this.className = className;
    this.classList = new ClassList(className);
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this.onclick = null;
    this.onsubmit = null;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  focus() {}
  click() { return this.onclick?.(); }
  get firstElementChild() { return this.children[0] || null; }
  set innerHTML(value) {
    this._innerHTML = value;
    if (this.id !== "options") return;
    optionElements = [...value.matchAll(/class="([^"]*option[^"]*)" data-value="([^"]+)"/g)]
      .map((match) => {
        const element = new MockElement("", match[1]);
        element.dataset.value = match[2];
        return element;
      });
  }
  get innerHTML() { return this._innerHTML || ""; }
}

let optionElements = [];

function makeButton(id, label) {
  const button = new MockElement(id);
  const span = new MockElement();
  span.textContent = label;
  button.append(span, new MockElement());
  return button;
}

function createHarness() {
  const ids = [
    "url", "error", "find", "title", "platform", "duration", "thumb", "card",
    "options", "queue", "queue-count", "download-all", "clear", "queue-list",
    "queue-summary", "progress", "form", "add-queue", "download",
    "settings-open", "settings-close", "settings-save", "settings-panel",
    "setting-mode", "setting-preset", "setting-mp3", "setting-parallel", "parallel-label",
    "setting-subtitles", "setting-metadata", "setting-thumbnail", "setting-sponsor",
    "setting-clipboard", "engine-update", "engine-update-status", "quality-detail",
    "duplicate-warning", "history-count", "history-list"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new MockElement(id)]));
  elements.find = makeButton("find", "Find video →");
  elements["add-queue"] = makeButton("add-queue", "Add to queue");
  elements.download = makeButton("download", "Download now");
  elements["download-all"] = makeButton("download-all", "Download all");
  const tabs = ["video", "audio"].map((mode, index) => {
    const tab = new MockElement("", index === 0 ? "tab active" : "tab");
    tab.dataset.mode = mode;
    return tab;
  });
  const document = {
    getElementById: (id) => elements[id],
    querySelectorAll: (selector) => selector === ".tab" ? tabs : optionElements,
    createElement: () => new MockElement()
  };
  return { document, elements, tabs };
}

test("local HTML keeps two links and runs both downloads concurrently", async () => {
  const html = fs.readFileSync(new URL("../local_app/index.html", import.meta.url), "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "inline application script should exist");
  const { document, elements } = createHarness();
  let storedSettings = null;
  const context = vm.createContext({
    document,
    console,
    localStorage: {
      getItem: () => null,
      setItem: (_key, value) => { storedSettings = value; }
    },
    URL,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error("test URLs must not call the network"); }
  });
  vm.runInContext(scriptMatch[1], context);

  for (const id of ["one", "two"]) {
    elements.url.value = `https://example.com/fluxsave-test/${id}`;
    await elements.form.onsubmit({ preventDefault() {} });
    elements["add-queue"].onclick();
  }

  assert.equal(elements["queue-count"].textContent, 2);
  assert.equal(elements["queue-list"].children.length, 2);
  elements["queue-list"].children[1].children[3].children[2].onclick();
  assert.equal(elements["queue-list"].children[1].children[2].textContent, "paused");
  elements["queue-list"].children[1].children[3].children[2].onclick();
  assert.equal(elements["queue-list"].children[1].children[2].textContent, "waiting");
  elements["queue-list"].children[0].children[3].children[1].onclick();
  assert.equal(elements["queue-list"].children[0].children[1].children[0].textContent, "FluxSave Queue Test two");
  elements["queue-list"].children[0].children[3].children[1].onclick();
  const runPromise = elements["download-all"].onclick();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const activeStatuses = elements["queue-list"].children.map((row) => row.children[2].textContent);
  assert.deepEqual(activeStatuses, ["downloading", "downloading"]);

  await runPromise;
  const finalStatuses = elements["queue-list"].children.map((row) => row.children[2].textContent);
  assert.deepEqual(finalStatuses, ["done", "done"]);
  assert.equal(elements["queue-count"].textContent, 2);

  elements["settings-open"].onclick();
  assert.equal(elements["settings-panel"].classList.contains("open"), true);
  elements["setting-mode"].value = "audio";
  elements["setting-preset"].value = "mp3";
  elements["setting-mp3"].value = "192";
  elements["setting-parallel"].value = "3";
  elements["settings-save"].onclick();
  assert.deepEqual(JSON.parse(storedSettings), {
    defaultMode: "audio",
    preset: "mp3",
    mp3Quality: "192",
    parallelDownloads: 3,
    subtitles: false,
    metadata: true,
    thumbnail: false,
    sponsorBlock: "off",
    clipboard: false
  });
  assert.equal(elements["parallel-label"].textContent, "3");
  assert.equal(elements["settings-panel"].classList.contains("open"), false);

  elements.url.value = "https://example.com/fluxsave-test/three https://example.com/fluxsave-test/four";
  await elements.form.onsubmit({ preventDefault() {} });
  assert.equal(elements["queue-count"].textContent, 4);
});
