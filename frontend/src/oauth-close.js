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
  window.close();
})();
