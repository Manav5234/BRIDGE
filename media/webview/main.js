(function () {
  "use strict";

  var api = acquireVsCodeApi();
  var $ = function (id) {
    return document.getElementById(id);
  };

  var els = {
    dot: $("dot"),
    statusText: $("statusText"),
    workspace: $("workspace"),
    setup: $("setup"),
    setupMessage: $("setupMessage"),
    setupGuidance: $("setupGuidance"),
    setupConnect: $("setupConnect"),
    setupSettings: $("setupSettings"),
    chat: $("chat"),
    sessionSelect: $("sessionSelect"),
    newSession: $("newSession"),
    messages: $("messages"),
    errorBox: $("errorBox"),
    errorText: $("errorText"),
    retry: $("retry"),
    input: $("input"),
    send: $("send"),
    stop: $("stop"),
  };

  /** Rendered messages, keyed by id, so streaming appends never rebuild the transcript. */
  var rendered = new Map();
  var state = null;

  function post(type, extra) {
    var message = { type: type };
    if (extra) {
      for (var key in extra) message[key] = extra[key];
    }
    api.postMessage(message);
  }

  function baseName(path) {
    if (!path) return "";
    var parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
  }

  function atBottom() {
    return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
  }

  function createMessageElement(message) {
    var el = document.createElement("article");
    el.className = "msg msg-" + message.role;
    el.dataset.id = message.id;

    var head = document.createElement("div");
    head.className = "msg-head";

    var role = document.createElement("span");
    role.className = "msg-role";
    role.textContent = message.role === "user" ? "You" : "OpenCode";
    head.appendChild(role);

    var model = document.createElement("span");
    model.className = "msg-model";
    head.appendChild(model);

    var body = document.createElement("div");
    body.className = "msg-body";

    var tools = document.createElement("ul");
    tools.className = "msg-tools";

    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(tools);

    return { el: el, body: body, model: model, tools: tools };
  }

  function paintMessage(entry, message) {
    entry.body.textContent = message.text;
    entry.model.textContent = message.model
      ? message.model.providerID + "/" + message.model.id
      : "";
    entry.el.classList.toggle("is-pending", Boolean(message.pending));
    entry.el.classList.toggle("is-failed", Boolean(message.failed));

    entry.tools.textContent = "";
    var tools = message.tools || [];
    for (var i = 0; i < tools.length; i++) {
      var item = document.createElement("li");
      item.className = "tool tool-" + tools[i].status;
      item.textContent = tools[i].name;
      entry.tools.appendChild(item);
    }
    entry.tools.classList.toggle("hidden", tools.length === 0);
  }

  function renderMessages(messages) {
    var stick = atBottom();
    var seen = new Set();

    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      seen.add(message.id);
      var entry = rendered.get(message.id);
      if (!entry) {
        entry = createMessageElement(message);
        rendered.set(message.id, entry);
      }
      paintMessage(entry, message);
      // appendChild moves an existing node, so order stays correct on re-render.
      els.messages.appendChild(entry.el);
    }

    rendered.forEach(function (entry, id) {
      if (!seen.has(id)) {
        entry.el.remove();
        rendered.delete(id);
      }
    });

    if (stick) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function renderSessions(sessions, activeID) {
    var previous = els.sessionSelect.value;
    els.sessionSelect.textContent = "";

    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = sessions.length ? "Select a session" : "No sessions yet";
    els.sessionSelect.appendChild(placeholder);

    for (var i = 0; i < sessions.length; i++) {
      var option = document.createElement("option");
      option.value = sessions[i].id;
      option.textContent = sessions[i].title;
      els.sessionSelect.appendChild(option);
    }

    var desired = activeID || previous || "";
    els.sessionSelect.value = desired;
  }

  function render(next) {
    state = next;
    var connected = next.connection.status === "connected";
    var setup = next.setup;

    els.dot.className = "dot dot-" + next.connection.status;
    els.statusText.textContent = next.status || next.connection.status;
    els.statusText.title = next.connection.message || "";

    var parts = [];
    if (next.workspace.directory) parts.push(baseName(next.workspace.directory));
    if (next.connection.version) parts.push("OpenCode " + next.connection.version);
    els.workspace.textContent = parts.join(" · ");
    els.workspace.title = [next.connection.message, next.connection.baseUrl]
      .filter(Boolean)
      .join("\n");

    els.setup.classList.toggle("hidden", !setup);
    els.chat.classList.toggle("hidden", Boolean(setup));

    if (setup) {
      els.setupMessage.textContent = setup.message;
      var guidance = setup.guidance || "";
      els.setupGuidance.textContent = guidance;
      els.setupGuidance.classList.toggle("hidden", guidance === "");
      els.setupConnect.disabled = next.connection.status === "connecting";
      els.setupConnect.textContent =
        next.connection.status === "connecting" ? "Connecting..." : "Connect";
    }

    if (connected) {
      renderSessions(next.sessions, next.activeSessionID);
      renderMessages(next.messages);
    } else {
      rendered.forEach(function (entry) {
        entry.el.remove();
      });
      rendered.clear();
    }

    var error = next.error;
    els.errorBox.classList.toggle("hidden", !error);
    if (error) {
      els.errorText.textContent = error.message;
      els.retry.classList.toggle("hidden", !error.retryable);
    }

    els.send.disabled = Boolean(setup) || next.busy;
    els.input.disabled = Boolean(setup);
    els.stop.disabled = Boolean(setup) || !next.busy;
    els.input.placeholder = setup ? "Connect to OpenCode first" : "Message OpenCode";
  }

  function onDelta(messageID, text) {
    var entry = rendered.get(messageID);
    // The host always sends full state before a message's first delta.
    if (!entry) return;
    var stick = atBottom();
    entry.body.textContent += text;
    if (stick) els.messages.scrollTop = els.messages.scrollHeight;
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "state") render(message.state);
    else if (message.type === "delta") onDelta(message.messageID, message.text);
  });

  els.setupConnect.addEventListener("click", function () {
    post("connect");
  });
  els.setupSettings.addEventListener("click", function () {
    post("openSettings");
  });
  els.newSession.addEventListener("click", function () {
    post("newSession");
  });
  els.sessionSelect.addEventListener("change", function () {
    var value = els.sessionSelect.value;
    if (value) post("selectSession", { sessionID: value });
  });
  els.sessionSelect.addEventListener("focus", function () {
    post("refreshSessions");
  });
  els.send.addEventListener("click", submit);
  els.stop.addEventListener("click", function () {
    post("stop");
  });
  els.retry.addEventListener("click", function () {
    post("retry");
  });

  els.input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  function submit() {
    if (!state || state.busy) return;
    var text = els.input.value;
    if (text.trim() === "") return;
    // requestID lets the host deduplicate a double click without blocking a real resend.
    post("send", { text: text, requestID: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8) });
    els.input.value = "";
    els.input.focus();
  }

  post("ready");
})();
