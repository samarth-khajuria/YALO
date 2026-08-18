// Client for tf-service-tester-chat.
// Reads the control-plane URL from window.CONTROL_PLANE_URL (config.js),
// keeps the JWT in localStorage, and implements login / send / history / logout.
// Persona is chosen from the navbar (Cowboy default, Osho as a tab).

(function () {
  "use strict";

  var BASE = (window.CONTROL_PLANE_URL || "http://localhost:8000").replace(/\/+$/, "");
  var TOKEN_KEY = "tf_token";
  var LABELS = { cowboy: "Cowboy", osho: "Osho" };

  var activePersona = "cowboy";

  var loginView = document.getElementById("login-view");
  var chatView = document.getElementById("chat-view");
  var loginForm = document.getElementById("login-form");
  var loginError = document.getElementById("login-error");
  var logoutBtn = document.getElementById("logout");
  var chatForm = document.getElementById("chat-form");
  var messageInput = document.getElementById("message");
  var sendBtn = document.getElementById("send-btn");
  var messagesEl = document.getElementById("messages");
  var personaName = document.getElementById("persona-name");
  var personaTabs = Array.prototype.slice.call(document.querySelectorAll(".persona-tab"));

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function setPersona(persona) {
    activePersona = persona;
    personaName.textContent = LABELS[persona] || persona;
    personaTabs.forEach(function (tab) {
      var on = tab.getAttribute("data-persona") === persona;
      tab.classList.toggle("active", on);
    });
  }

  function showLogin() {
    loginView.hidden = false;
    chatView.hidden = true;
    logoutBtn.hidden = true;
    personaTabs.forEach(function (t) { t.hidden = true; });
  }

  function showChat() {
    loginView.hidden = true;
    chatView.hidden = false;
    logoutBtn.hidden = false;
    personaTabs.forEach(function (t) { t.hidden = false; });
  }

  // A 401 anywhere means the session is gone: drop the token and re-show login.
  function handleUnauthorized() {
    clearToken();
    messagesEl.innerHTML = "";
    showLogin();
  }

  function addBubble(role, content) {
    var div = document.createElement("div");
    div.className = "bubble " + (role === "user" ? "user" : "assistant");
    div.textContent = content;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function renderMessages(messages) {
    messagesEl.innerHTML = "";
    messages.forEach(function (m) { addBubble(m.role, m.content); });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // --- typing indicator ---
  var typingEl = null;
  function showTyping() {
    typingEl = document.createElement("div");
    typingEl.className = "bubble assistant typing";
    typingEl.setAttribute("aria-label", (LABELS[activePersona] || "bot") + " is typing");
    typingEl.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) { typingEl.parentNode.removeChild(typingEl); }
    typingEl = null;
  }
  function setBusy(busy) {
    sendBtn.disabled = busy;
    messageInput.disabled = busy;
    if (!busy) { messageInput.focus(); }
  }

  function loadHistory() {
    var token = getToken();
    if (!token) { return; }
    var persona = activePersona;
    fetch(BASE + "/api/history?persona=" + encodeURIComponent(persona), {
      headers: { "Authorization": "Bearer " + token }
    })
      .then(function (res) {
        if (res.status === 401) { handleUnauthorized(); return null; }
        if (!res.ok) { throw new Error("history failed"); }
        return res.json();
      })
      .then(function (data) {
        // Ignore if the user switched personas while this was in flight.
        if (data && persona === activePersona) { renderMessages(data.messages || []); }
      })
      .catch(function () { /* non-fatal */ });
  }

  // --- login ---
  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.hidden = true;
    var email = document.getElementById("email").value;
    var password = document.getElementById("password").value;

    fetch(BASE + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    })
      .then(function (res) {
        if (res.status === 401) { throw new Error("Invalid credentials"); }
        if (!res.ok) { throw new Error("Login failed"); }
        return res.json();
      })
      .then(function (data) {
        setToken(data.token);
        setPersona("cowboy");
        showChat();
        loadHistory();
      })
      .catch(function (err) {
        loginError.textContent = err.message || "Login failed";
        loginError.hidden = false;
      });
  });

  // --- send ---
  chatForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var token = getToken();
    if (!token) { handleUnauthorized(); return; }
    var text = messageInput.value.trim();
    if (!text) { return; }

    var persona = activePersona;
    addBubble("user", text);
    messageInput.value = "";
    setBusy(true);
    showTyping();

    fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ persona: persona, message: text })
    })
      .then(function (res) {
        if (res.status === 401) { hideTyping(); handleUnauthorized(); return null; }
        if (!res.ok) { throw new Error("chat failed"); }
        return res.json();
      })
      .then(function (data) {
        hideTyping();
        if (data) { addBubble("assistant", data.reply); }
      })
      .catch(function () {
        hideTyping();
        addBubble("assistant", "[the service could not be reached]");
      })
      .then(function () { setBusy(false); });
  });

  // --- persona switch from the navbar ---
  personaTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var persona = tab.getAttribute("data-persona");
      if (persona === activePersona) { return; }
      setPersona(persona);
      messagesEl.innerHTML = "";
      loadHistory();
    });
  });

  // --- logout ---
  logoutBtn.addEventListener("click", function () {
    clearToken();
    messagesEl.innerHTML = "";
    setPersona("cowboy");
    showLogin();
  });

  // --- boot ---
  setPersona("cowboy");
  if (getToken()) {
    showChat();
    loadHistory();
  } else {
    showLogin();
  }
})();
