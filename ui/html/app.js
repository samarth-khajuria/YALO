// Client for tf-service-tester-chat.
// Reads the control-plane URL from window.CONTROL_PLANE_URL (config.js),
// keeps the JWT in localStorage, and implements login / send / history / logout.

(function () {
  "use strict";

  var BASE = (window.CONTROL_PLANE_URL || "http://localhost:8000").replace(/\/+$/, "");
  var TOKEN_KEY = "tf_token";

  var loginView = document.getElementById("login-view");
  var chatView = document.getElementById("chat-view");
  var loginForm = document.getElementById("login-form");
  var loginError = document.getElementById("login-error");
  var logoutBtn = document.getElementById("logout");
  var chatForm = document.getElementById("chat-form");
  var messageInput = document.getElementById("message");
  var messagesEl = document.getElementById("messages");

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function currentPersona() {
    var checked = document.querySelector('input[name="persona"]:checked');
    return checked ? checked.value : "cowboy";
  }

  function showLogin() {
    loginView.hidden = false;
    chatView.hidden = true;
    logoutBtn.hidden = true;
  }

  function showChat() {
    loginView.hidden = true;
    chatView.hidden = false;
    logoutBtn.hidden = false;
  }

  // A 401 anywhere means the session is gone: drop the token and re-show login.
  function handleUnauthorized() {
    clearToken();
    messagesEl.innerHTML = "";
    showLogin();
  }

  function renderMessages(messages) {
    messagesEl.innerHTML = "";
    messages.forEach(function (m) {
      addBubble(m.role, m.content);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addBubble(role, content) {
    var div = document.createElement("div");
    div.className = "bubble " + (role === "user" ? "user" : "assistant");
    div.textContent = content;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function loadHistory() {
    var token = getToken();
    if (!token) { return; }
    fetch(BASE + "/api/history?persona=" + encodeURIComponent(currentPersona()), {
      headers: { "Authorization": "Bearer " + token }
    })
      .then(function (res) {
        if (res.status === 401) { handleUnauthorized(); return null; }
        if (!res.ok) { throw new Error("history failed"); }
        return res.json();
      })
      .then(function (data) {
        if (data) { renderMessages(data.messages || []); }
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

    var persona = currentPersona();
    addBubble("user", text);
    messageInput.value = "";

    fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ persona: persona, message: text })
    })
      .then(function (res) {
        if (res.status === 401) { handleUnauthorized(); return null; }
        if (!res.ok) { throw new Error("chat failed"); }
        return res.json();
      })
      .then(function (data) {
        if (data) { addBubble("assistant", data.reply); }
      })
      .catch(function () {
        addBubble("assistant", "[the service could not be reached]");
      });
  });

  // --- persona toggle reloads that persona's history ---
  Array.prototype.forEach.call(document.querySelectorAll('input[name="persona"]'), function (el) {
    el.addEventListener("change", loadHistory);
  });

  // --- logout ---
  logoutBtn.addEventListener("click", function () {
    clearToken();
    messagesEl.innerHTML = "";
    showLogin();
  });

  // --- boot ---
  if (getToken()) {
    showChat();
    loadHistory();
  } else {
    showLogin();
  }
})();
