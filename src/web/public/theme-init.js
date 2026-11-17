// Runs before the page paints, so the chosen theme is applied immediately (no light flash before dark loads).
// Kept as a separate file because the site's Content-Security-Policy does not allow inline scripts.
(function () {
  var mode;
  try {
    mode = localStorage.getItem("fortress-helpdesk:theme");
    if (mode !== "light" && mode !== "dark") {
      var display = location.pathname.replace(/\/+$/, "").toLowerCase() === "/admin" && location.hash === "#tv";
      mode = display ? "dark" : window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch (e) {
    mode = "light";
  }
  document.documentElement.classList.add("theme-" + mode);
})();
