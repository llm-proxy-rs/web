// OAuth callback close page script.
// Reads result from URL params, broadcasts via BroadcastChannel, and closes the window.
(function () {
  var params = new URLSearchParams(window.location.search);
  var result = params.get("mcp_oauth");
  if (!result) return;
  var reason = params.get("reason");
  var msg = { type: "mcp_oauth", result: result };
  if (reason) msg.reason = reason;
  var ch = new BroadcastChannel("mcp_oauth");
  ch.postMessage(msg);
  ch.close();
  // Clean URL
  window.history.replaceState({}, "", "/");
  // Update UI based on result
  var isSuccess = result === "success";
  var icon = document.getElementById("icon");
  var iconCheck = document.getElementById("icon-check");
  var iconX = document.getElementById("icon-x");
  var status = document.getElementById("status");
  var detail = document.getElementById("detail");
  var closeBtn = document.getElementById("close-btn");
  if (!isSuccess && icon) {
    icon.className = "icon icon-error";
    if (iconCheck) iconCheck.style.display = "none";
    if (iconX) iconX.style.display = "block";
  }
  if (status) {
    status.textContent = isSuccess
      ? "Authorization successful"
      : "Authorization failed";
  }
  if (detail) {
    detail.textContent = isSuccess
      ? "Your MCP server has been connected. This window will close automatically."
      : reason
        ? "Something went wrong (" +
          reason.replace(/_/g, " ") +
          "). You can close this window and try again."
        : "Something went wrong. You can close this window and try again.";
  }
  if (closeBtn) closeBtn.style.display = "inline-block";
  window.close();
})();
