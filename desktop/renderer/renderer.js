const el = (id) => document.getElementById(id);
const state = {
  mode: "video",
  quality: "best",
  info: null,
  currentUrl: "",
  currentQueued: false,
  folder: null,
  file: null,
  downloading: false,
  queueRunning: false,
  cancelRequested: false,
  activeButton: "download",
  currentDownloadId: null,
  queue: []
};
let checkingTimer = null;

function authSettings() {
  return {
    useBrowserCookies: el("use-login").checked,
    browser: el("login-browser").value
  };
}

function duration(seconds) {
  if (!seconds) return "Duration unavailable";
  const min = Math.floor(seconds / 60);
  const sec = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${min}:${sec} • Public media`;
}

function setError(message = "") {
  el("error").textContent = String(message).replace(/^ERROR:\s*/, "");
}

function displayInfo(info) {
  el("title").textContent = info.title;
  el("platform").textContent = `● ${info.platform} link detected`;
  const sourceLabel = info.sourceHeight ? ` • Source up to ${info.sourceHeight}p` : "";
  el("details").textContent = `${duration(info.duration)}${sourceLabel}`;
  el("thumb").style.backgroundImage = info.thumbnail ? `url("${info.thumbnail}")` : "";
  el("result").style.display = "block";
}

function updateAddButton() {
  const button = el("add-queue");
  button.disabled = !state.info || state.downloading || state.currentQueued;
  button.textContent = state.currentQueued ? "✓ Added to queue" : "＋ Add to queue";
}

function renderOptions() {
  const values = state.mode === "audio"
    ? [["320", "320 kbps"], ["256", "256 kbps"], ["192", "192 kbps"], ["128", "128 kbps"]]
    : [["best", "Best available"], ...(state.info?.resolutions || []).slice(0, 11).map((value) => [
      String(value),
      value === 4320 ? "4320p · 8K" : value === 2160 ? "2160p · 4K" : value === 1440 ? "1440p · 2K" : `${value}p`
    ])];
  state.quality = values[0][0];
  el("options").innerHTML = values.map(([value, label], index) =>
    `<button class="option ${index === 0 ? "active" : ""}" data-value="${value}">${label}</button>`
  ).join("");
  document.querySelectorAll(".option").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".option").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.quality = button.dataset.value;
      state.currentQueued = false;
      updateAddButton();
    });
  });
}

function qualityLabel(job) {
  if (job.mode === "audio") return `${job.quality} kbps MP3`;
  if (job.quality === "best") return "Best available MP4";
  return `${job.quality}p MP4`;
}

function currentJob() {
  if (!state.info || !state.currentUrl) return null;
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    url: state.currentUrl,
    mode: state.mode,
    quality: state.quality,
    folder: state.folder,
    title: state.info.title,
    sourceHeight: state.info.sourceHeight,
    duration: state.info.duration,
    info: { ...state.info },
    auth: authSettings(),
    status: "waiting",
    error: ""
  };
}

function renderQueue() {
  el("queue-panel").style.display = state.queue.length ? "block" : "none";
  el("queue-count").textContent = String(state.queue.length);
  el("clear-queue").disabled = state.downloading || !state.queue.some((job) => job.status !== "downloading");
  el("download-queue").disabled = state.downloading || !state.queue.some((job) => job.status !== "done");
  const list = el("queue-list");
  list.replaceChildren();
  state.queue.forEach((job, index) => {
    const item = document.createElement("div");
    item.className = "queue-item";

    const number = document.createElement("span");
    number.className = "queue-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const copy = document.createElement("div");
    copy.className = "queue-copy";
    const title = document.createElement("strong");
    title.textContent = job.title;
    const detail = document.createElement("small");
    detail.textContent = job.error || `${job.info.platform} · ${qualityLabel(job)}`;
    copy.append(title, detail);

    const status = document.createElement("span");
    status.className = `queue-status ${job.status}`;
    status.textContent = job.status === "downloading"
      ? `${Math.round(job.percent || 0)}%`
      : job.status;

    const remove = document.createElement("button");
    remove.className = "queue-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove from queue";
    remove.disabled = state.downloading || job.status === "downloading";
    remove.addEventListener("click", () => {
      state.queue = state.queue.filter((itemJob) => itemJob.id !== job.id);
      renderQueue();
    });

    item.append(number, copy, status, remove);
    list.append(item);
  });
}

function setProgressStart(buttonId, label) {
  state.activeButton = buttonId;
  state.file = null;
  el("complete").style.display = "none";
  el("progress-wrap").style.display = "flex";
  el("progress").style.width = "0%";
  el("percent").textContent = "0%";
  const button = el(buttonId);
  button.disabled = true;
  button.firstElementChild.textContent = label;
  button.classList.add("working");
  el("progress-wrap").classList.add("indeterminate");
}

function resetDownloadControls() {
  ["download", "download-queue"].forEach((id) => {
    const button = el(id);
    button.classList.remove("working");
    button.disabled = false;
  });
  el("download").firstElementChild.textContent = "Download now";
  el("download-queue").firstElementChild.textContent = "Download all";
  el("cancel-download").style.display = "none";
  el("cancel-queue").style.display = "none";
  el("progress-wrap").classList.remove("indeterminate");
  updateAddButton();
  renderQueue();
}

async function downloadJob(job) {
  return window.fluxsave.download({
    id: job.id,
    url: job.url,
    mode: job.mode,
    quality: job.quality,
    folder: job.folder || state.folder,
    title: job.title,
    sourceHeight: job.sourceHeight,
    duration: job.duration,
    auth: job.auth
  });
}

el("analyze-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError();
  const requestedUrl = el("url").value.trim();
  el("find").disabled = true;
  el("find").innerHTML = '<i class="button-spinner"></i> Checking…';
  el("checking-panel").style.display = "flex";
  const checkingMessages = [
    ["Checking the link…", "Connecting to the video source"],
    ["Reading video details…", "Finding every available resolution"],
    ["Almost ready…", "Preparing quality and audio choices"]
  ];
  let messageIndex = 0;
  checkingTimer = setInterval(() => {
    messageIndex = (messageIndex + 1) % checkingMessages.length;
    el("checking-title").textContent = checkingMessages[messageIndex][0];
    el("checking-detail").textContent = checkingMessages[messageIndex][1];
  }, 1400);
  try {
    state.info = await window.fluxsave.analyze({
      url: requestedUrl,
      auth: authSettings()
    });
    state.currentUrl = requestedUrl;
    state.currentQueued = false;
    displayInfo(state.info);
    el("complete").style.display = "none";
    renderOptions();
    updateAddButton();
  } catch (error) {
    setError(error.message || "Could not inspect that link.");
  } finally {
    clearInterval(checkingTimer);
    checkingTimer = null;
    el("checking-panel").style.display = "none";
    el("find").disabled = false;
    el("find").innerHTML = "Find video <b>→</b>";
  }
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.mode = button.dataset.mode;
    state.currentQueued = false;
    renderOptions();
    updateAddButton();
  });
});

el("choose-folder").addEventListener("click", async () => {
  const folder = await window.fluxsave.chooseFolder();
  if (folder) {
    state.folder = folder;
    el("folder").textContent = folder;
  }
});

el("add-queue").addEventListener("click", () => {
  const job = currentJob();
  if (!job) return;
  const duplicate = state.queue.some((item) =>
    item.url === job.url && item.mode === job.mode && item.quality === job.quality
  );
  if (duplicate) {
    setError("That link and quality are already in the queue.");
    return;
  }
  state.queue.push(job);
  state.currentQueued = true;
  updateAddButton();
  renderQueue();
  el("url").value = "";
  el("url").focus();
  setError();
});

el("clear-queue").addEventListener("click", () => {
  if (state.downloading) return;
  state.queue = state.queue.filter((job) => job.status === "done");
  renderQueue();
});

el("download").addEventListener("click", async () => {
  if (state.downloading) return;
  const job = currentJob();
  if (!job) return;
  setError();
  state.downloading = true;
  state.cancelRequested = false;
  state.currentDownloadId = job.id;
  setProgressStart("download", "Starting download…");
  el("download-queue").disabled = true;
  el("cancel-download").style.display = "block";
  updateAddButton();
  try {
    const result = await downloadJob(job);
    state.file = result.path;
    el("complete").style.display = "flex";
  } catch (error) {
    setError(/cancel/i.test(error.message || "") ? "Download cancelled." : (error.message || "Download failed."));
  } finally {
    state.downloading = false;
    state.currentDownloadId = null;
    resetDownloadControls();
  }
});

el("download-queue").addEventListener("click", async () => {
  if (state.downloading || !state.queue.length) return;
  setError();
  state.downloading = true;
  state.queueRunning = true;
  state.cancelRequested = false;
  setProgressStart("download-queue", "Starting queue…");
  el("download").disabled = true;
  el("cancel-queue").style.display = "block";
  updateAddButton();
  renderQueue();
  let completed = 0;
  let failed = 0;
  try {
    const jobs = state.queue.filter((job) => job.status !== "done");
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < jobs.length && !state.cancelRequested) {
        const job = jobs[nextIndex];
        nextIndex += 1;
        job.status = "downloading";
        job.percent = 0;
        job.error = "";
        renderQueue();
        try {
          const result = await downloadJob(job);
          job.status = "done";
          job.percent = 100;
          job.result = result;
          state.file = result.path;
          completed += 1;
        } catch (error) {
          if (state.cancelRequested || /cancel/i.test(error.message || "")) {
            job.status = "waiting";
            job.percent = 0;
            break;
          }
          job.status = "failed";
          job.percent = 0;
          job.error = String(error.message || "Download failed.");
          failed += 1;
        }
        renderQueue();
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(2, jobs.length) },
      () => worker()
    ));
    if (completed) el("complete").style.display = "flex";
    if (failed) setError(`${failed} queued download${failed === 1 ? "" : "s"} failed. You can retry the queue.`);
  } finally {
    state.downloading = false;
    state.queueRunning = false;
    resetDownloadControls();
  }
});

function cancelCurrentDownload() {
  if (!state.downloading) return;
  state.cancelRequested = true;
  el("cancel-download").disabled = true;
  el("cancel-queue").disabled = true;
  if (state.queueRunning) {
    state.queue
      .filter((job) => job.status === "downloading")
      .forEach((job) => window.fluxsave.cancel(job.id));
  } else {
    window.fluxsave.cancel(state.currentDownloadId);
  }
  setTimeout(() => {
    el("cancel-download").disabled = false;
    el("cancel-queue").disabled = false;
  }, 700);
}

el("cancel-download").addEventListener("click", cancelCurrentDownload);
el("cancel-queue").addEventListener("click", cancelCurrentDownload);
el("show-file").addEventListener("click", () => window.fluxsave.showFile(state.file));

window.fluxsave.onProgress((value) => {
  const progress = typeof value === "number" ? { percent: value } : value;
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
  el("progress-wrap").classList.remove("indeterminate");
  if (state.queueRunning) {
    const job = state.queue.find((item) => item.id === progress.jobId);
    if (!job) return;
    job.percent = percent;
    job.phase = progress.phase;
    const active = state.queue.filter((item) => item.status === "downloading").length;
    const done = state.queue.filter((item) => item.status === "done").length;
    const aggregate = state.queue.length
      ? Math.round(state.queue.reduce((sum, item) => (
          sum + (item.status === "done" ? 100 : item.status === "downloading" ? (item.percent || 0) : 0)
        ), 0) / state.queue.length)
      : 0;
    el("download-queue").firstElementChild.textContent = `${active} active · ${done}/${state.queue.length} done`;
    el("progress").style.width = `${aggregate}%`;
    el("percent").textContent = `${aggregate}% overall`;
    renderQueue();
    return;
  }
  if (progress.jobId && progress.jobId !== state.currentDownloadId) return;
  const button = el(state.activeButton);
  if (!state.queueRunning) {
    button.firstElementChild.textContent = progress.phase === "convert"
      ? "Converting to H.264 MP4…"
      : percent < 100 ? "Downloading…" : "Finishing…";
  }
  el("progress").style.width = `${percent}%`;
  let eta = progress.eta || "";
  if (!eta && Number.isFinite(progress.etaSeconds)) {
    const seconds = Math.max(0, Math.round(progress.etaSeconds));
    eta = seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`
      : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  }
  const speed = progress.speed && progress.speed !== "NA" ? ` · ${progress.speed}` : "";
  el("percent").textContent = `${percent}%${eta ? ` · ${eta} left` : ""}${speed}`;
});

window.fluxsave.onEngineStatus((status) => {
  el("engine-status").textContent = status;
});

el("use-login").addEventListener("change", () => {
  el("login-browser").disabled = !el("use-login").checked;
});

el("login-browser").disabled = true;
updateAddButton();
renderQueue();
